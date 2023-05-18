// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')
const pull = require('pull-stream')
const pullMany = require('pull-many')
const deepEqual = require('fast-deep-equal')

module.exports = async function replicate(...peers) {
  if (peers.length === 1 && Array.isArray(peers[0])) peers = peers[0]
  if (peers.length === 2) return replicatePair(...peers)

  return pull(
    pull.values(peers),
    pull.asyncMap((person1, cb) => {
      pull(
        pull.values(peers),
        pull.asyncMap((person2, cb) => {
          if (person1.id === person2.id) return cb(null, true)

          replicatePair(person1, person2)
            .then((res) => cb(null, true))
            .catch((err) => cb(err))
        }),
        pull.collect(cb)
      )
    }),
    pull.collectAsPromise()
  )
}

/**
 * Fully replicates person1's metafeed tree to person2 and vice versa
 */
async function replicatePair(person1, person2) {
  // const start = Date.now()
  // const ID = [person1, person2]
  //   .map(p => p.name || p.id.slice(0, 10))
  //   .join('-')

  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  const isSync = await ebtReplicate(person1, person2).catch((err) =>
    console.error('Error with ebtReplicate:\n', err)
  )
  if (!isSync) {
    console.error('EBT failed to replicate! Final state:')
    console.log(person1.id, await p(person1.getVectorClock)())
    console.log(person2.id, await p(person2.getVectorClock)())
  }

  await p(conn.close)(true).catch(console.error)
  // const time = Date.now() - start
  // const length = Math.max(Math.round(time / 100), 1)
  // console.log(ID, Array(length).fill('▨').join(''), time + 'ms')
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
