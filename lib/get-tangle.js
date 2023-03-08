// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const Reduce = require('@tangle/reduce')
const Strategy = require('@tangle/strategy')
const clarify = require('clarify-error')
const { isIdentityGroupSSBURI } = require('ssb-uri2')

// for figuring out what "previous" should be for the group

const strategy = new Strategy({})

/** `server` is the ssb server you're using. `tangle` is the name of the tangle in the group you're looking for, e.g. "group" or "members" */
module.exports = function GetTangle(server, tangle) {
  const getUpdates = GetUpdates(server, tangle)

  return function getTangle(groupId, cb) {
    if (!isIdentityGroupSSBURI(groupId)) {
      // prettier-ignore
      return cb(new Error(`get-tangle expects valid groupId, got: ${groupId}`))
    }

    server.box2.getGroupKeyInfo(groupId, (err, info) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to get group key info when getting a tangle'))

      if (!info) {
        return cb(new Error(`get-tangle: unknown groupId ${groupId}`))
      }

      getUpdates(info.root, (err, msgs) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to read updates when getting tangle'))

        const nodes = msgs.map((msg) => ({
          key: msg.key,
          previous: msg.value.content.tangles[tangle].previous,
        }))
        // NOTE: getUpdates query does not get root node
        nodes.push({ key: info.root, previous: null })

        // Create a Reduce using the message contents
        // NOTE - do NOT store the whole msg (node)
        // we're not doing any reducing of transformations, we care only about
        // reducing the graph to find the tips
        // each node should be pruned down to e.g. { key: '%D', previous: ['%B', '%C'] }

        const reduce = new Reduce(strategy, { nodes })
        cb(null, {
          root: info.root,
          previous: Object.keys(reduce.state),
        })
      })
    })
  }
}

const B_VALUE = Buffer.from('value')
const B_CONTENT = Buffer.from('content')
const B_TANGLES = Buffer.from('tangles')
const B_ROOT = Buffer.from('root')

function GetUpdates(ssb, tangle) {
  const { seekKey } = require('bipf')
  const B_TANGLE = Buffer.from(tangle)

  function tangleRoot(value) {
    return ssb.db.operators.equal(seekTangleRoot, value, {
      indexType: `value.content.tangles.${tangle}.root`,
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
    const { where, and, toPullStream } = ssb.db.operators
    pull(
      ssb.db.query(where(and(tangleRoot(id))), toPullStream()),
      pull.collect(cb)
    )
  }
}
