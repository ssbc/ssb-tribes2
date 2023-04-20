// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify: p } = require('util')
const { fromMessageSigil } = require('ssb-uri2')
const pull = require('pull-stream')
const Reduce = require('@tangle/reduce')
const OverwriteFields = require('@tangle/overwrite-fields')
const clarify = require('clarify-error')
const Butt64 = require('butt64')
const isCanonicalBase64 = require('is-canonical-base64')
const {
  validator: {
    group: {
      initRoot: isInitRoot,
      initEpoch: isInitEpoch,
      addMember: isAddMember,
      exclude: isExclude,
    },
  },
} = require('private-group-spec')

const getTangleUpdates = require('./tangles/get-tangle-updates')

const msgPattern = toPattern(new Butt64('ssb:message/[a-zA-Z0-9-]+/', null, 32))
const feedPattern = toPattern(new Butt64('ssb:feed/[a-zA-Z0-9-]+/', null, 32))
const secretPattern = toPattern(isCanonicalBase64(null, null, 32))

function toPattern(regexp) {
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
      pattern: feedPattern,
    },
    epochKey: {
      type: 'string',
      pattern: secretPattern,
    },
  },
})
strategy.mapToPure = (T) => T || strategy.identity() // function @tangle/reduce needs

module.exports = function Epochs(ssb) {
  function getEpochs(groupId, cb) {
    if (cb === undefined) return p(getEpochs)(groupId)

    reduceEpochs(ssb, groupId, (err, reduce) => {
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      const epochs = reduce.graph.connectedNodes.map((node) => {
        return {
          id: node.key,
          previous: node.previous,
          author: node.data[node.key].author,
          epochKey: Buffer.from(node.data[node.key].epochKey, 'base64'),
        }
      })

      cb(null, epochs)
    })
  }

  /**
   * Get the epoch matching the currently picked write key for the group.
   */
  function getPickedEpoch(groupId, opts) {
    return pull(
      opts?.live
        ? ssb.box2.getGroupInfoUpdates(groupId)
        : pull(ssb.box2.getGroupInfoUpdates(groupId), pull.take(1)),
      pull.compareToTheLastOne?isTheWriteKeyDifferent?
    )

    ssb.box2.getGroupInfo(groupId, (err, info) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to get group info for ' + groupId))

      // prettier-ignore
      if (info.excluded) return cb(new Error("Can't get picked epoch for group we're excluded from"))

      getEpochs(groupId, (err, epochs) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'todo'))

        cb(
          null,
          epochs.find((epoch) => epoch.epochKey.equals(info.writeKey.key))
        )
      })
    })
  }

  function getMembers(epochRoot, cb) {
    if (cb === undefined) return p(getMembers)(epochRoot)

    getEpochMembers(ssb, epochRoot, cb)
  }

  return {
    getEpochs,
    getPickedEpoch,
    getMembers,
  }
}

function reduceEpochs(ssb, groupId, cb) {
  ssb.box2.getGroupInfo(groupId, (err, info) => {
    if (err) return cb(clarify(err, 'Failed to get group info for ' + groupId))

    ssb.db.get(info.root, (err, rootVal) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to load group root with id ' + info.root))

      if (!isInitRoot(rootVal))
        // prettier-ignore
        return cb(clarify(new Error(isInitRoot.string), 'Malformed group/init root message'))

      const root = { key: info.root, value: rootVal }

      getTangleUpdates(ssb, 'epoch', info.root, (err, updates) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to updates of group epoch tangle'))

        pull(
          pull.values([root, ...updates.filter(isInitEpoch)]),
          pull.asyncMap((msg, cb) => {
            ssb.metafeeds.findRootFeedId(msg.value.author, (err, feedId) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed find root feed id of ' + msg.value.author))

              const key = toMsgURI(msg.key)
              cb(null, {
                key,
                previous: msg.value.content.tangles.epoch.previous,
                data: {
                  [key]: {
                    author: feedId,
                    epochKey: msg.value.content.groupKey,
                  },
                },
              })
            })
          }),
          pull.collect((err, nodes) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failure collecting epoch messages'))

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
function toMsgURI(id) {
  return id.startsWith('%') ? fromMessageSigil(id) : id
}

function getEpochMembers(ssb, epochRoot, cb) {
  const members = new Set()
  const toExclude = new Set()

  pull(
    getTangleUpdates.stream(ssb, 'members', epochRoot),
    pull.filter((msg) => isAddMember(msg) || isExclude(msg)),
    pull.drain(
      (msg) => {
        const { type, recps, excludes } = msg.value.content
        if (type === 'group/add-member')
          recps.slice(1).forEach((feedId) => members.add(feedId))
        else excludes.forEach((feedId) => toExclude.add(feedId))
      },
      (err) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to resolve epoch membership'))
        cb(null, {
          members: [...members],
          toExclude: [...toExclude],
        })
      }
    )
  )
}
