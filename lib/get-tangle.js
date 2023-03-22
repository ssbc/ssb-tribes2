// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const Reduce = require('@tangle/reduce')
const Strategy = require('@tangle/strategy')
const clarify = require('clarify-error')
const { isIdentityGroupSSBURI, fromMessageSigil } = require('ssb-uri2')
const { where, author, toPullStream } = require('ssb-db2/operators')

const strategy = new Strategy({})

function toUri(link) {
  if (typeof link !== 'string') return link
  return link.startsWith('%') ? fromMessageSigil(link) : link
}

function getTangleRoot(server, groupId, tangle, cb) {
  server.box2.getGroupInfo(groupId, (err, info) => {
    // prettier-ignore
    if (err) return cb(clarify(err, 'Failed to get group info when getting a tangle'))

    if (!info) {
      return cb(new Error(`get-tangle: unknown groupId ${groupId}`))
    }

    if (tangle === 'members') {
      // we find the id of the init msg for the current epoch
      pull(
        server.metafeeds.branchStream({ old: true, live: false }),
        pull.filter((branch) => branch.length === 4),
        pull.map((branch) => branch[3]),
        pull.filter(
          (feed) => feed.purpose === info.writeKey.key.toString('base64')
        ),
        pull.map((feed) =>
          pull(
            server.db.query(where(author(feed.id)), toPullStream()),
            pull.take(1)
          )
        ),
        pull.flatten(),
        pull.filter((msg) => msg.value?.content?.type === 'group/init'),
        pull.take(1),
        pull.drain(
          (msg) => cb(null, fromMessageSigil(msg.key)),
          (err) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find init msg for current epoch when trying to get members tangle'))
          }
        )
      )
    } else {
      return cb(null, info.root)
    }
  })
}

/** for figuring out what "previous" should be for the group. `server` is the ssb server you're using. `tangle` is the name of the tangle in the group you're looking for, e.g. "group" or "members" */
function getTangle(server, tangle, groupId, cb) {
  if (!isIdentityGroupSSBURI(groupId)) {
    // prettier-ignore
    return cb(new Error(`get-tangle expects valid groupId, got: ${groupId}`))
  }

  getTangleRoot(server, groupId, tangle, (err, root) => {
    // prettier-ignore
    if (err) return cb(clarify(err, 'Failed to get tangle root when getting tangle'))

    getUpdates(server, tangle, root, (err, msgs) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to read updates when getting tangle'))

      const nodes = msgs.map((msg) => ({
        key: toUri(msg.key),
        previous: msg.value.content.tangles[tangle].previous,
      }))
      // NOTE: getUpdates query does not get root node
      nodes.push({ key: root, previous: null })

      // Create a Reduce using the message contents
      // NOTE - do NOT store the whole msg (node)
      // we're not doing any reducing of transformations, we care only about
      // reducing the graph to find the tips
      // each node should be pruned down to e.g. { key: '%D', previous: ['%B', '%C'] }

      const reduce = new Reduce(strategy, { nodes })
      cb(null, {
        root,
        previous: Object.keys(reduce.state),
      })
    })
  })
}
module.exports = getTangle

const B_VALUE = Buffer.from('value')
const B_CONTENT = Buffer.from('content')
const B_TANGLES = Buffer.from('tangles')
const B_ROOT = Buffer.from('root')

function getUpdates(ssb, tangle, root, cb) {
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

  const { where, and, toPullStream } = ssb.db.operators
  pull(
    ssb.db.query(where(and(tangleRoot(root))), toPullStream()),
    pull.collect(cb)
  )
}
