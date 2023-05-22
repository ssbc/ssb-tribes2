// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')
const pull = require('pull-stream')
const pullMany = require('pull-many')
const deepEqual = require('fast-deep-equal')

/**
 * Fully replicates between two or more peers
 *
 * Known bug: If you're e.g. created a group and posted in it but not invited anyone before replicating, then the group creator has to be the first peer listed. This is because we use branchStream (which only lists feeds you can decrypt the metafeed tree reference to) to figure out what to replicate, but we use getVectorClock (which lists *every* feed you have) to figure out when replication is done. So doing bob<->alice (where alice created the group) then bob<->carol fails, because bob can't pass along the group feed that alice posted on.
 */
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
            .then(() => cb(null, true))
            .catch((err) => cb(err))
        }),
        pull.collect(cb)
      )
    }),
    pull.collectAsPromise()
  )
}

async function replicatePair(person1, person2) {
  // const start = Date.now()
  // let ID = [person1, person2].map((p) => p.name || p.id.slice(0, 10)).join('-')
  // while (ID.length < 12) ID += ' '

  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  const isSync = await ebtReplicate(person1, person2).catch((err) =>
    console.error('Error with ebtReplicate:\n', err)
  )
  if (!isSync) {
    console.error('EBT failed to replicate! Final state:')
    console.error(person1.id, await p(person1.getVectorClock)())
    console.error(person2.id, await p(person2.getVectorClock)())
  }

  await p(conn.close)(true).catch(console.error)

  // const time = Date.now() - start
  // const length = Math.max(Math.round(time / 100), 1)
  // console.log(ID, Array(length).fill('▨').join(''), time + 'ms')
}

async function ebtReplicate(person1, person2) {
  // ensure persons are replicating all the trees in their forests,
  // from top to bottom
  const feedIds = await getFeedsToSync(person1, person2)

  pull(
    pull.values(feedIds),
    pull.asyncMap((feedId, cb) => {
      // hack to make it look like we request feeds in the right order
      // instead of just one big pile, ssb-meta-feeds operates under
      // the assumption that we get messages in proper order
      setTimeout(() => cb(null, feedId), 200)
    }),
    pull.drain((feedId) => {
      person1.ebt.request(feedId, true)
      person2.ebt.request(feedId, true)
    })
  )

  // Wait until both have replicated all feeds in full (are in sync)
  const isSync = async () => {
    const clocks = await Promise.all([
      p(person1.getVectorClock)(),
      p(person2.getVectorClock)(),
    ])
    return feedIds.every((feedId) => clocks[0][feedId] === clocks[1][feedId])
  }
  const isSuccess = await retryUntil(isSync)

  return isSuccess
}

async function getFeedsToSync(person1, person2) {
  return pull(
    pullMany([
      person1.metafeeds.branchStream({ old: true, live: false }),
      person2.metafeeds.branchStream({ old: true, live: false }),
    ]),
    pull.flatten(),
    pull.map((feedDetails) => feedDetails.id),
    pull.unique(),
    pull.collectAsPromise()
  )
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
