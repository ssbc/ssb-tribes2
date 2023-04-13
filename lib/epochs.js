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

// This strategy describes how to "reduce" the tangle of epochs and their data.
// Here OverwriteFieleds lets any link in the tangle contain Objects with form
// { [key]: value } so long as
//   - key matches msgPattern,
//   - value is { author, epochKey }
//
// Since each key is unique here this behaves like Object.assign (with checks)
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
// PATCH: @tangle/reduce needs this
strategy.mapToPure = T => T || strategy.identity()

module.exports = function Epochs (ssb) {
  function getEpochs (groupId, cb) {
    if (cb === undefined) return p(getEpochs)(groupId)

    const getters = {
      author (msg, cb) {
        ssb.metafeeds.findRootFeedId(msg.value.author, cb)
      },
      epochKey (msg, cb) {
        cb(null, msg.value.content.groupKey)
      }
    }

    reduceEpochs(ssb, groupId, getters, (err, reduce) => {
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      const epochs = reduce.graph.connectedNodes
        .map(node => {
          const info = {
            id: node.key, // alias: epochRoot
            previous: node.previous,
            ...node.data[node.key]
          }
          info.epochKey = Buffer.from(info.epochKey, 'base64')
          return info
        })

      cb(null, epochs)
    })
  }

  function getMembers (epochRoot, cb) {
    if (cb === undefined) return p(getMembers)(epochRoot)

    getEpochMembers(ssb, epochRoot, cb)
  }

  return {
    getEpochs,
    getMembers,
  }
}

function reduceEpochs (ssb, groupId, getters = {}, cb) {
  // getters is an Object of form:
  // {
  //   [fieldName]: fieldGetter(msg, cb)
  // }
  ssb.box2.getGroupInfo(groupId, (err, info) => {
    if (err) return cb(clarify(err, 'Failed to get group info for ' + groupId))

    ssb.db.get(info.root, (err, rootVal) => {
      if (err) return cb(clarify(err, 'Failed to load group root with id ' + info.root))
      if (!isInitRoot(rootVal)) return cb(clarify(new Error(isInitRoot.string), 'Malformed group/init root message'))

      const root = { key: info.root, value: rootVal }

      getTangleUpdates(ssb, 'epoch', info.root, (err, updates) => {
        if (err) return cb(clarify(err, 'Failed to updates of group epoch tangle'))

        pull(
          pull.values([
            root,
            ...updates.filter(isInitEpoch)
          ]),
          pull.asyncMap((msg, cb) => {
            const epochRoot = toMsgURI(msg.key)
            const epochData = {}

            // go through all the getters, get their info, and attach it to epochData
            pull(
              pull.keys(getters),
              pull.asyncMap((fieldName, cb) => {
                const getter = getters[fieldName]
                getter(msg, (err, fieldData) => {
                  if (err) return cb(clarify(err, 'Failed to get epoch ' + fieldName))
                  epochData[fieldName] = fieldData
                  cb(null)
                })
              }),
              pull.collect((err) => {
                if (err) return cb(clarify(err, 'Failed to collect epoch data'))

                cb(null, {
                  key: epochRoot,
                  previous: msg.value.content.tangles.epoch.previous,
                  data: {
                    [epochRoot]: epochData
                  }
                })
              })
            )
          }),
          pull.collect((err, nodes) => {
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
function toMsgURI (id) {
  return id.startsWith('%') ? fromMessageSigil(id) : id
}

function getEpochMembers (ssb, epochRoot, cb) {
  const members = new Set()
  const toExclude = new Set()

  pull(
    getTangleUpdates.stream(ssb, 'members', epochRoot),
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
        if (err) return cb(clarify(err, 'Failed to resolve epoch membership'))
        cb(null, {
          members: [...members],
          toExclude: [...toExclude],
        })
      }
    )
  )
}
