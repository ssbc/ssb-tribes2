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
const difference = require('set.prototype.difference')

const getTangleUpdates = require('./tangles/get-tangle-updates')

const msgPattern = toPattern(new Butt64('ssb:message/[a-zA-Z0-9-]+/', null, 32))
const feedPattern = toPattern(new Butt64('ssb:feed/[a-zA-Z0-9-]+/', null, 32))
const secretPattern = toPattern(isCanonicalBase64(null, null, 32))

// This strategy describes how to "reduce" the tangle of epochs and their data.
// Here OverwriteFieleds lets any link in the tangle contain Objects with form
// { [key]: value } so long as
//   - key matches msgPattern,
//   - value is { author, secret }
//
// Since each key is unique here this behaves like Object.assign (with checks)
const strategy = OverwriteFields({
  keyPattern: msgPattern,
  valueSchema: {
    type: 'object',
    properties: {
      author: {
        type: 'string',
        pattern: feedPattern
      },
      secret: {
        type: 'string',
        pattern: secretPattern
      },
      members: {
        type: 'object',
        properties: {
          added: { type: 'array' },
          toExclude: { type: 'array' }
        },
        required: ['added', 'toExclude'],
        additionalProperties: false
      }
    },
    required: ['author', 'secret'],
    additionalProperties: false
  }
})
// PATCH: @tangle/reduce needs this
strategy.mapToPure = T => T || strategy.identity()

module.exports = function Epochs (ssb) {
  const allGetters = {
    author (epochRoot, cb) {
      ssb.metafeeds.findRootFeedId(epochRoot.value.author, cb)
    },
    secret (epochRoot, cb) {
      cb(null, epochRoot.value.content.groupKey)
    },
    members (epochRoot, cb) {
      getMembers(ssb, epochRoot.key, cb)
    }
  }

  return {
    getEpochs (groupId, cb) {
      if (cb === undefined) return p(this.getEpochs)(groupId)

      const getters = pluck(allGetters, ['author', 'secret'])
      reduceEpochs(ssb, groupId, getters, (err, reduce) => {
        if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

        const epochs = reduce.graph.connectedNodes
          .map(node => {
            const info = {
              id: node.key, // alias: epochRootId
              previous: node.previous,
              ...node.data[node.key]
            }
            info.secret = Buffer.from(info.secret, 'base64')
            return info
          })

        cb(null, epochs)
      })
    },

    getMembers (epochRootId, cb) {
      if (cb === undefined) return p(this.getMembers)(epochRootId)

      getMembers(ssb, epochRootId, cb)
    },

    getMissingMembers (groupId, cb) {
      if (cb === undefined) return p(this.getMissingMembers)(groupId)

      reduceEpochs(ssb, groupId, allGetters, (err, reduce) => {
        if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

        if (reduce.graph.connectedNodes.length === 1) return cb(null, [])
        // INFO if there is only one connectedNode, there is only a
        // single epoch, so there's no need to check anything

        const result = reduce.graph.connectedNodes.reduce((acc, node) => {
          // For each node (epoch) in the tangle, determine which feeds have
          // historically been added / excluded.
          const addedSoFar = new Set()
          const excludedSoFar = new Set()
          ;[node.key, ...reduce.graph.getHistory(node.key)]
            .map(key => reduce.graph.getNode(key))
            .forEach(historyNode => {
              const { added, toExclude } = historyNode.data[historyNode.key].members
              added.forEach(feedId => addedSoFar.add(feedId))

              if (historyNode.key === node.key) return
              // INFO node members toExclude is talking about what should happen
              // *after* it in the graph, so if we're enquiring about a
              // particular epoch, we don't include that epoch's toExclude
              toExclude.forEach(feedId => excludedSoFar.add(feedId))
            })

          // Check if those who should be present are present
          const shouldBePresent = difference(addedSoFar, excludedSoFar)
          const currentMembers = new Set(node.data[node.key].members.added)
          if (isSameSet(shouldBePresent, currentMembers)) return acc

          // If find some missing, record this epoch and missing members
          acc.push({
            epoch: node.key, // alias: epochRootId
            secret: Buffer.from(node.data[node.key].secret, 'base64'),
            missing: [...difference(shouldBePresent, currentMembers)]
          })
          return acc
        }, [])

        cb(null, result)
      })
    },

    tieBreak (epochs) {
      if (!epochs || !Array.isArray(epochs))
        throw Error('tieBreak requires an Array of epochs')

      const keys = epochs
        .map(epoch => epoch.epochKey.toString('hex'))
        .sort()
      console.log(keys)

      const winningKey = Buffer.from(keys[0], 'hex')
      
      return epochs.find(epoch => epoch.epochKey.equals(winningKey))
    }
  }
}

function reduceEpochs (ssb, groupId, getters = {}, cb) {
  // - `groupId` *String* ssb-uri for a group
  // - `getters` *Object* which describes which data fields you would like
  //   added to each epoch, and an async getter to aquire the data.
  //     - The getter is a function with signature `(epochRoot, cb)`.
  //     - e.g.:
  //       ```
  //       const getters = {
  //         author (epochRoot, cb) {
  //           getRootFeedId(epochRoot.value.author, cb)
  //         }
  //       }
  //       ```
  // - `cb` *Function* a callback which receives a @tangle/reduce result.
  //   This is an object which has produced a tangle of connected "nodes"
  //   (which each "node" is an epoch here), and we can access the graph
  //   and nodes under `resolve.graph` (which is a @tangle/graph object)

  ssb.box2.getGroupInfo(groupId, (err, info) => {
    if (err) return cb(clarify(err, 'Failed to get group info for ' + groupId))

    // Fetch the tangle root
    ssb.db.get(info.root, (err, rootVal) => {
      if (err) return cb(clarify(err, 'Failed to load group root with id ' + info.root))
      if (!isInitRoot(rootVal)) return cb(clarify(new Error(isInitRoot.string), 'Malformed group/init root message'))

      const root = { key: info.root, value: rootVal }

      // Fetch the tangle updates
      getTangleUpdates(ssb, 'epoch', info.root, (err, updates) => {
        if (err) return cb(clarify(err, 'Failed to updates of group epoch tangle'))

        // Take each root/update and build an epoch "node" for our tangle
        pull(
          pull.values([root, ...updates.filter(isInitEpoch)]),
          pull.asyncMap((msg, cb) => {
            const epochRootId = toMsgURI(msg.key)
            const epochData = {}
            const node = {
              key: epochRootId,
              previous: msg.value.content.tangles.epoch.previous,
              data: {
                [epochRootId]: epochData
              }
            }

            // Use out getters to attach desired data to our epoch "node"
            pull(
              pull.values(Object.entries(getters)),
              pull.asyncMap(([fieldName, getter], cb) => {
                getter(msg, (err, fieldData) => {
                  if (err) return cb(clarify(err, 'Failed to get epoch ' + fieldName))
                  epochData[fieldName] = fieldData
                  cb(null)
                })
              }),
              pull.collect((err) => {
                if (err) return cb(clarify(err, 'Failed to collect epoch data'))

                cb(null, node)
              })
            )
          }),
          pull.collect((err, nodes) => {
            if (err) return cb(clarify(err, 'Failure collecting epoch messages'))

            // Finally reduce all of these epoch nodes with a tangle
            const reduce = new Reduce(strategy, { nodes })
            reduce.resolve()
            // INFO this walks the graph and prunes disconnected nodes

            cb(null, reduce)
          })
        )
      })
    })
  })
}

function getMembers (ssb, epochRootId, cb) {
  epochRootId = toMsgURI(epochRootId)
  const added = new Set()
  const toExclude = new Set()

  pull(
    getTangleUpdates.stream(ssb, 'members', epochRootId),
    pull.filter(msg => isAddMember(msg) || isExclude(msg)),
    pull.drain(
      msg => {
        const { type, recps, excludes } = msg.value.content
        if (type === 'group/add-member')
          recps.slice(1).forEach(feedId => added.add(feedId))
        else
          excludes.forEach(feedId => toExclude.add(feedId))
      },
      err => {
        if (err) return cb(clarify(err, 'Failed to resolve epoch membership'))
        cb(null, {
          added: [...added],
          toExclude: [...toExclude],
        })
      }
    )
  )
}

/* HELPERS */
function toPattern (regexp) {
  return regexp.toString().replace(/^\//, '').replace(/\/$/, '')
}

function toMsgURI (id) {
  return id.startsWith('%') ? fromMessageSigil(id) : id
}

function pluck (obj, keys) {
  return keys.reduce((acc, key) => {
    acc[key] = obj[key]
    return acc
  }, {})
}

function isSameSet (a, b) {
  if (a.size !== b.size) return false

  for (const el of a) {
    if (!b.has(el)) return false
  }

  return true
}
