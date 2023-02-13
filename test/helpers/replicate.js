// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')
const pull = require('pull-stream')
const pullMany = require('pull-many')
const deepEqual = require('fast-deep-equal')

/**
 * Fully replicates person1's metafeed tree to person2 and vice versa
 */
module.exports = async function replicate(person1, person2) {
  // persons replicate all the trees in their forests, from top to bottom
  let drain
  pull(
    pullMany([
      person1.metafeeds.branchStream({ old: true, live: true }),
      person2.metafeeds.branchStream({ old: true, live: true }),
    ]),
    pull.flatten(),
    pull.map((feedDetails) => feedDetails.id),
    pull.unique(),
    pull.asyncMap((feedId, cb) => {
      // hack to make it look like we request feeds in the right order
      // instead of just one big pile, ssb-meta-feeds operates under
      // the assumption that we get messages in proper order
      setTimeout(() => {
        cb(null, feedId)
      }, 200)
    }, 1),
    (drain = pull.drain((feedId) => {
      person1.ebt.request(feedId, true)
      person2.ebt.request(feedId, true)
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

  drain.abort()

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
