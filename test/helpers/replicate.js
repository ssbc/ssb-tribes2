// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')
const pull = require('pull-stream')
const deepEqual = require('fast-deep-equal')

/**
 * Fully replicates person1's metafeed tree to person2 and vice versa
 */
module.exports = async function replicate(person1, person2) {
  // Replicate self
  person1.ebt.request(person1.id, true)
  person2.ebt.request(person2.id, true)

  // Replicate each other's main feeds
  person1.ebt.request(person2.id, true)
  person2.ebt.request(person1.id, true)

  const person1Root = await p(person1.metafeeds.findOrCreate)()
  const person2Root = await p(person2.metafeeds.findOrCreate)()

  // Replicate each other's metafeed roots
  person1.ebt.request(person1Root.id, true)
  person1.ebt.request(person2Root.id, true)
  person2.ebt.request(person1Root.id, true)
  person2.ebt.request(person2Root.id, true)

  // person1 replicate all the trees in their forest, from top to bottom
  let drain1
  pull(
    person1.metafeeds.branchStream({ old: true, live: true }),
    pull.flatten(),
    pull.map((feedDetails) => feedDetails.id),
    pull.unique(),
    (drain1 = pull.drain((feedId) => {
      person1.ebt.request(feedId, true)
      person2.ebt.request(feedId, true)
    }))
  )

  // person2 replicate all the trees in their forest, from top to bottom
  let drain2
  pull(
    person2.metafeeds.branchStream({ old: true, live: true }),
    pull.flatten(),
    pull.map((feedDetails) => feedDetails.id),
    pull.unique(),
    (drain2 = pull.drain((feedId) => {
      person2.ebt.request(feedId, true)
      person1.ebt.request(feedId, true)
    }))
  )

  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  // Wait until both have replicated all feeds in full
  await retryUntil(async () => {
    const newClock1 = await p(person1.getVectorClock)()
    const newClock2 = await p(person2.getVectorClock)()
    return deepEqual(newClock1, newClock2)
  })

  drain1.abort()
  drain2.abort()

  await p(conn.close)(true)
}

async function retryUntil(fn) {
  let result = false
  for (let i = 0; i < 100; i++) {
    result = await fn()
    if (result) return
    else await p(setTimeout)(100)
  }
  if (!result) throw new Error('retryUntil timed out')
}
