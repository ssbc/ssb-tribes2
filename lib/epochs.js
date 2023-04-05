// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify: p } = require('util')
const { fromMessageSigil } = require('ssb-uri2')
const pull = require('pull-stream')
const Reduce = require('@tangle/reduce')
const OverwriteFields = require('@tangle/overwrite-fields')
const Butt64 = require('butt64')
const isCanonicalBase64 = require('is-canonical-base64')
const {
  validator: {
    group: {
      initRoot: isInitRoot,
      initEpoch: isInitEpoch,
      addMember: isAddMember,
      exclude: isExclude,
    }
  }
} = require('private-group-spec')

const getTangleUpdates = require('./tangles/get-tangle-updates')

const msgPattern = toPattern(new Butt64('ssb:message/[a-zA-Z0-9-]+/', null, 32))
const feedPattern = toPattern(new Butt64('ssb:feed/[a-zA-Z0-9-]+/', null, 32))
const secretPattern = toPattern(isCanonicalBase64(null, null, 32))

function toPattern (regexp) {
  return regexp.toString().replace(/^\//, '').replace(/\/$/, '')
}

const strategy = OverwriteFields({
  keyPattern: msgPattern,
  valueSchema: {
    type: 'object',
    properties: ['author', 'epochKey'],
    required: ['author', 'epochKey'],
    author: {
      type: 'string',
      pattern: feedPattern
    },
    epochKey: {
      type: 'string',
      pattern: secretPattern
    }
  }
})
strategy.mapToPure = T => T || strategy.identity() // function @tangle/reduce needs

module.exports = function Epochs (ssb) {
  function getEpochs (groupId, cb) {
    if (cb === undefined) return p(getEpochs)(groupId)

    reduceEpochs(ssb, groupId, (err, reduce) => {
      if (err) return cb(err)

      const epochs = reduce.graph.connectedNodes
        .map(node => {
          return {
            id: node.key,
            previous: node.previous,
            author: node.data[node.key].author,
            epochKey: Buffer.from(node.data[node.key].epochKey, 'base64')
          }
        })

      cb(null, epochs)
    })
  }

  function getMembers (epochId, cb) {
    if (cb === undefined) return p(getMembers)(epochId)

    getEpochMembers(ssb, epochId, cb)
  }

  return {
    getEpochs,
    getMembers,
  }
}

function reduceEpochs (ssb, groupId, cb) {
  ssb.box2.getGroupInfo(groupId, (err, info) => {
    if (err) return cb(err)

    ssb.db.get(info.root, (err, rootVal) => {
      if (err) return cb(err)
      if (!isInitRoot(rootVal)) return cb(new Error(isInitRoot.string))

      const root = { key: info.root, value: rootVal }

      getTangleUpdates(ssb, 'epoch', info.root, (err, updates) => {
        if (err) return cb(err)

        pull(
          pull.values([
            root,
            ...updates.filter(isInitEpoch)
          ]),
          pull.asyncMap((msg, cb) => {
            ssb.metafeeds.findRootFeedId(msg.value.author, (err, feedId) => {
              if (err) return cb(err)

              const key = toMsgURI(msg.key)
              cb(null, {
                key,
                previous: msg.value.content.tangles.epoch.previous,
                data: {
                  [key]: {
                    author: feedId,
                    epochKey: msg.value.content.groupKey
                  }
                }
              })
            })
          }),
          pull.collect((err, nodes) => {
            if (err) return cb(err)

            const reduce = new Reduce(strategy, { nodes })
            // walk the graph and prune invalid links
            reduce.resolve()

            cb(null, reduce)
          })
        )
      })
    })
  })
}
function toMsgURI (id) {
  return id.startsWith('%') ? fromMessageSigil(id) : id
}

function getEpochMembers (ssb, epochId, cb) {
  const members = new Set()
  const toExclude = new Set()

  pull(
    getTangleUpdates.stream(ssb, 'members', epochId),
    pull.filter(msg => isAddMember(msg) || isExclude(msg)),
    pull.drain(
      msg => {
        const { type, recps, excludes } = msg.value.content
        if (type === 'group/add-member')
          recps.slice(1).forEach(feedId => members.add(feedId))
        else
          excludes.forEach(feedId => toExclude.add(feedId))
      },
      err => {
        if (err) return cb(err)
        cb(null, {
          members: [...members],
          toExclude: [...toExclude],
        })
      }
    )
  )
}
