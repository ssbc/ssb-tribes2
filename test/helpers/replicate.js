// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

/* eslint-disable no-console */

const { promisify: p } = require('util')
const pull = require('pull-stream')
const pullMany = require('pull-many')

const TIMEOUT = 100
const TRIES = 150

// Fully replicates between two or more peers
/*
Known bug: order of peers passed in seems to matter. We think this is
a bug in EBT replication.
Recommend making the first peer listed the creator of the group?
*/
module.exports = async function replicate(...peers) {
  if (peers.length === 1 && Array.isArray(peers[0])) peers = peers[0]

  if (peers.length === 2) {
    return replicatePair(...peers).catch((err) => {
      console.log(
        err.message,
        JSON.stringify(namifyObject(err.state, peers), null, 2)
      )
      throw err
    })
  }

  return pull(
    pull.values(peers),
    pull.asyncMap((person1, cb) => {
      pull(
        pull.values(peers),
        pull.asyncMap((person2, cb) => {
          if (person1.id === person2.id) return cb(null, true)

          replicatePair(person1, person2)
            .then(() => cb(null, true))
            .catch((err) => {
              console.log(
                err.message,
                JSON.stringify(namifyObject(err.state, peers), null, 2)
              )
              cb(err)
            })
        }),
        pull.collect(cb)
      )
    }),
    pull.collectAsPromise()
  )
}

const runTimer = !false
async function replicatePair(person1, person2) {
  let ID = [person1, person2].map(getName).join('-')
  while (ID.length < 12) ID += ' '
  let start
  if (runTimer) {
    start = Date.now()
  }

  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  await ebtReplicate(person1, person2).catch((err) => {
    err.message = ID + ' FAILED'
    throw err
  })

  await p(conn.close)(true).catch(console.error)

  if (runTimer) {
    const time = Date.now() - start
    const length = Math.max(Math.round(time / TIMEOUT), 1)
    console.log(ID, Array(length).fill('▨').join(''), time + 'ms')
  }
}

async function ebtReplicate(person1, person2) {
  // ensure persons are replicating all the trees in their forests,
  // from top to bottom
  const feedIds = await getFeedsToSync(person1, person2)

  const requested = new Set()

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
      requested.add(feedId)
    })
  )

  let clocks

  // Wait until both have replicated all feeds in full (are in sync)
  const isSync = async () => {
    clocks = await Promise.all([
      p(person1.getVectorClock)(),
      p(person2.getVectorClock)(),
    ])
    return feedIds.every((feedId) => clocks[0][feedId] === clocks[1][feedId])
  }
  const isSuccess = await retryUntil(isSync)

  if (!isSuccess) {
    const problemFeeds = feedIds.filter(
      (feedId) => clocks[0][feedId] !== clocks[1][feedId]
    )
    const err = new Error('EBT failed to sync')
    err.state = {
      [person1.id]: problemFeeds.reduce((acc, feedId) => {
        acc[feedId] = clocks[0][feedId]
        return acc
      }, {}),
      [person2.id]: problemFeeds.reduce((acc, feedId) => {
        acc[feedId] = clocks[1][feedId]
        return acc
      }, {}),
    }
    throw err
  }
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
  for (let i = 0; i < TRIES; i++) {
    isDone = await checkIsDone()
    if (isDone) return true

    await p(setTimeout)(TIMEOUT)
  }

  return false
}

function getName(peer) {
  return peer.name || peer.id.slice(0, 10)
}

function namifyObject(object, peers) {
  return Object.entries(object).reduce((acc, [key, value]) => {
    const peer = peers.find((peer) => peer.id === key)

    const newKey = peer ? getName(peer) : key
    const newValue =
      typeof value === 'object' ? namifyObject(value, peers) : value

    acc[newKey] = newValue
    return acc
  }, {})
}
