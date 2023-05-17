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
  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  const isSync = await ebtReplicate()

  if (!isSync) {
    console.error('EBT failed to replicate! Final state:')
    console.log(person1.id, await p(person1.getVectorClock)())
    console.log(person2.id, await p(person2.getVectorClock)())
  }

  await p(conn.close)(true)
}

async function ebtReplicate(person1, person2) {
  // ensure persons are replicating all the trees in their forests,
  // from top to bottom
  const stream = setupFeedRequests(person1, person2)

  // Wait until both have replicated all feeds in full (are in sync)
  const isSync = async () => {
    const clocks = await Promise.all([
      p(person1.getVectorClock)(),
      p(person2.getVectorClock)(),
    ])
    return deepEqual(...clocks)
  }
  const isSuccess = await retryUntil(isSync)

  stream.abort()
  return isSuccess
}

function setupFeedRequests(person1, person2) {
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
      // skip re-requesting if not needed
      // if (feedId in clock1 && feedId in clock2) return cb(null, null)

      // hack to make it look like we request feeds in the right order
      // instead of just one big pile, ssb-meta-feeds operates under
      // the assumption that we get messages in proper order
      setTimeout(() => cb(null, feedId), 200)
    }),
    // pull.filter(Boolean), // filter out "null" entries
    (drain = pull.drain((feedId) => {
      person1.ebt.request(feedId, true)
      person2.ebt.request(feedId, true)
    }))
  )

  return drain
}

// try an async task up to 100 times till it returns true
// if success retryUntil returns true, otherwise false
async function retryUntil(checkIsDone) {
  let isDone = false
  for (let i = 0; i < 100; i++) {
    isDone = await checkIsDone()
    if (isDone) return true

    await p(setTimeout)(100)
  }

  return false
}
