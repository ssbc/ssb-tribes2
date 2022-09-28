// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { isCloakedMsg: isGroup } = require('ssb-ref')
const pull = require('pull-stream')
const Reduce = require('@tangle/reduce')
const Strategy = require('@tangle/strategy')
const {
  where,
  and,
  isDecrypted,
  type,
  live,
  toPullStream,
} = require('ssb-db2/operators')

// for figuring out what "previous" should be for the group

const strategy = new Strategy({})

module.exports = function GetGroupTangle(server) {
  const getUpdates = GetUpdates(server)
  const cache = new Map([]) // groupId > new Reduce (tangleTips)

  // LISTEN
  // listen to all new messages that come in
  // if a new message comes in which has msg.value.content.tangles.group.root that is in cache
  // update the value in the cache (this will use our new addNodes functionality)

  pull(
    server.db.query(
      where(isDecrypted('box2')),
      live({ old: false }),
      toPullStream()
    ),
    pull.drain(updateCache)
  )

  function updateCache(msg) {
    const { recps, tangles } = msg.value.content
    // If the message has recipients get the group ID, which may be the first slot.
    const msgGroupId = recps && recps[0]
    // Check if msg is part of a cached group
    if (cache.has(msgGroupId)) {
      // Add message to Reduce
      if (tangles && tangles.group && tangles.group.previous) {
        cache.get(msgGroupId).addNodes([
          {
            key: msg.key,
            previous: tangles.group.previous,
          },
        ]) // Get key and previous from msg
      }
    }
  }

  return function getGroupTangle(groupId, cb) {
    if (!isGroup(groupId))
      return cb(
        new Error(`get-group-tangle expects valid groupId, got: ${groupId}`)
      )

    server.box2.getGroupKeyInfo(groupId, (err, info) => {
      if (err) return cb(err)

      if (!info)
        return cb(new Error(`get-group-tangle: unknown groupId ${groupId}`))

      // if it's in the cache, then get the cached value, then callback
      if (cache.has(groupId)) {
        return cb(null, {
          root: info.root,
          previous: Object.keys(cache.get(groupId).state),
        })
      }
      // if not in cache, compute it and add to the cache

      //TODO: actually test getUpdates. it's only really used on a restarted server?
      getUpdates(info.root, (err, nodes) => {
        if (err) return cb(err)

        // NOTE: getUpdates query does not get root node
        nodes.push({ key: info.root, previous: null })

        // Create a Reduce using the message contents
        // NOTE - do NOT store the whole msg (node)
        // we're not doing any reducing of transformations, we care only about
        // reducing the graph to find the tips
        // each node should be pruned down to e.g. { key: '%D', previous: ['%B', '%C'] }

        const reduce = new Reduce(strategy, { nodes })
        // Store Reduce in the cache to use/update it later.
        cache.set(groupId, reduce)
        cb(null, {
          root: info.root,
          previous: Object.keys(reduce.state),
        })
      })
      //)
    })
  }
}

const B_VALUE = Buffer.from('value')
const B_CONTENT = Buffer.from('content')
const B_TANGLES = Buffer.from('tangles')
const B_ROOT = Buffer.from('root')

function GetUpdates(ssb) {
  const { seekKey } = require('bipf')
  //const { spec } = crut
  //const isUpdate = (msg) =>
  //  crut.isUpdate(getCanonicalContent(msg, spec.getTransformation))
  const B_TANGLE = Buffer.from('group')

  function tangleRoot(value) {
    return ssb.db.operators.equal(seekTangleRoot, value, {
      indexType: `value.content.tangles.group.root`,
    })
  }
  function seekTangleRoot(buffer) {
    let p = 0 // note you pass in p!
    p = seekKey(buffer, p, B_VALUE)
    if (p < 0) return
    p = seekKey(buffer, p, B_CONTENT)
    if (p < 0) return
    p = seekKey(buffer, p, B_TANGLES)
    if (p < 0) return
    p = seekKey(buffer, p, B_TANGLE)
    if (p < 0) return
    return seekKey(buffer, p, B_ROOT)
  }

  return function getUpdates(id, cb) {
    const { where, and, type, toPullStream } = ssb.db.operators
    pull(
      ssb.db.query(where(and(type('group'), tangleRoot(id))), toPullStream()),
      //pull.filter(isUpdate),
      pull.collect(cb)
    )
  }
}
