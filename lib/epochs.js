// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify: p } = require('util')
const { fromMessageSigil } = require('ssb-uri2')
const pull = require('pull-stream')
const pullDefer = require('pull-defer')
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
      excludeMember: isExcludeMember,
    },
  },
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
        pattern: feedPattern,
      },
      secret: {
        type: 'string',
        pattern: secretPattern,
      },
      members: {
        type: 'object',
        properties: {
          added: { type: 'array' },
          toExclude: { type: 'array' },
        },
        required: ['added', 'toExclude'],
        additionalProperties: false,
      },
    },
    required: ['author', 'secret'],
    additionalProperties: false,
  },
})
// PATCH: @tangle/reduce needs this
strategy.mapToPure = (T) => T || strategy.identity()

module.exports = function Epochs(ssb) {
  const allGetters = {
    author(epochRoot, cb) {
      ssb.metafeeds.findRootFeedId(epochRoot.value.author, cb)
    },
    secret(epochRoot, cb) {
      cb(null, epochRoot.value.content.groupKey)
    },
    members(epochRoot, cb) {
      getMembers(epochRoot.key, cb)
    },
  }

  function getEpochs(groupId, cb) {
    if (cb === undefined) return p(getEpochs)(groupId)

    const opts = { getters: pluck(allGetters, ['author', 'secret']) }
    reduceEpochs(ssb, groupId, opts, (err, reduce) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      const epochs = reduce.graph.connectedNodes.map((node) => {
        const info = {
          id: node.key, // alias: epochRootId
          previous: node.previous,
          ...node.data[node.key],
        }
        info.secret = Buffer.from(info.secret, 'base64')
        return info
      })

      cb(null, epochs)
    })
  }

  function getMembers(epochRootId, cb) {
    if (cb === undefined) return p(getMembers)(epochRootId)

    epochRootId = toMsgURI(epochRootId)
    const added = new Set()
    const toExclude = new Set()

    pull(
      getTangleUpdates.stream(ssb, 'members', epochRootId),
      pull.filter((msg) => isAddMember(msg) || isExcludeMember(msg)),
      pull.through((msg) => {
        const { type, recps, excludes } = msg.value.content
        if (type === 'group/add-member')
          recps.slice(1).forEach((feedId) => added.add(feedId))
        else return excludes.forEach((feedId) => toExclude.add(feedId))
      }),
      pull.collect((err) => {
        if (err) return cb(clarify(err, 'Failed to resolve epoch membership'))

        cb(null, {
          added: [...added],
          toExclude: [...toExclude],
        })
      })
    )
  }
  getMembers.stream = function getMembersStream(epochRootId, opts = {}) {
    const { live } = opts

    const deferredSource = pullDefer.source()

    getMembers(epochRootId, (err, res) => {
      // prettier-ignore
      if (err) return deferredSource.abort(clarify(err, 'error getting members'))

      if (!live) {
        deferredSource.resolve(pull.once(res))
        return
      }

      const added = new Set(res.added)
      const toExclude = new Set(res.toExclude)

      const source = pull(
        // create a stream of "there is an update" events
        pull.values([
          // one event for current state
          pull.once(true),

          // run a live stream, only emiting "true" if there is new info in the
          // message that comes in
          pull(
            getTangleUpdates.stream(ssb, 'members', epochRootId, { live }),
            pull.map((msg) => {
              if (isAddMember(msg)) {
                const initialSize = added.size
                msg.value.content.recps
                  .slice(1)
                  .forEach((feedId) => added.add(feedId))
                return added.size > initialSize
              }

              if (isExcludeMember(msg)) {
                const initialSize = toExclude.size
                msg.value.content.excludes.forEach((feedId) =>
                  toExclude.add(feedId)
                )
                return toExclude.size > initialSize
              }

              return false
            }),
            pull.filter(Boolean)
          ),
        ]),
        pull.flatten(),

        // for each "there is an update" event, map that to emitting the current
        // membereship state of the epoch
        pull.map(() => {
          return {
            added: [...added],
            toExclude: [...toExclude],
          }
        })
      )

      return deferredSource.resolve(source)
    })

    return deferredSource
  }

  function getPreferredEpoch(groupId, cb) {
    if (cb === undefined) return p(getPreferredEpoch)(groupId)

    reduceEpochs(ssb, groupId, { getters: allGetters }, (err, reduce) => {
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      buildPreferredEpoch(reduce, cb)
    })
  }

  // prettier-ignore
  getPreferredEpoch.stream = function getPreferredEpochStream(groupId, opts = {}) {
    const { live } = opts // live is kinda redundent here

    const deferredSource = pullDefer.source()

    // we don't want to emit every epoch up till current, so we calculate the current,
    // then skip all the preferrentEpochs until we get up to the current
    // This is important for listMembers to not send confusing results
    getPreferredEpoch(groupId, (err, preferredEpoch) => {
      if (err) return deferredSource.abort(clarify(err, 'failed to get initial preferred epoch'))

      var sync = false
      const source = pull(
        reduceEpochs.stream(ssb, groupId, { getters: allGetters, live }),
        pull.asyncMap(buildPreferredEpoch),
        pull.filter(epoch => {
          // if have seen current preferredEpoch, allow through
          if (sync) return true
          // if we have reached current preferredEpoch, we're "in sync"
          if (epoch.id === preferredEpoch.id) {
            sync = true // start letting future updates through
            return true // let the current one through!
          }
          return false
        }),
      )

      deferredSource.resolve(source)
    })

    return deferredSource
  }

  function getMissingMembers(groupId, cb) {
    if (cb === undefined) return p(this.getMissingMembers).call(this, groupId)

    reduceEpochs(ssb, groupId, { getters: allGetters }, (err, reduce) => {
      // prettier-ignore
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
          .map((key) => reduce.graph.getNode(key))
          .forEach((historyNode) => {
            const { added, toExclude } =
              historyNode.data[historyNode.key].members
            added.forEach((feedId) => addedSoFar.add(feedId))

            if (historyNode.key === node.key) return
            // INFO node members toExclude is talking about what should happen
            // *after* it in the graph, so if we're enquiring about a
            // particular epoch, we don't include that epoch's toExclude
            toExclude.forEach((feedId) => excludedSoFar.add(feedId))
          })

        // Check if those who should be present are present
        const shouldBePresent = difference(addedSoFar, excludedSoFar)
        const currentMembers = new Set(node.data[node.key].members.added)
        if (isSameSet(shouldBePresent, currentMembers)) return acc

        // If find some missing, record this epoch and missing members
        acc.push({
          epoch: node.key, // alias: epochRootId
          secret: Buffer.from(node.data[node.key].secret, 'base64'),
          missing: [...difference(shouldBePresent, currentMembers)],
        })
        return acc
      }, [])

      cb(null, result)
    })
  }

  return {
    getEpochs,
    getMembers,
    getPreferredEpoch,
    getMissingMembers,
    tieBreak,
  }
}

function tieBreak(epochs) {
  if (!epochs || !Array.isArray(epochs))
    throw Error('tieBreak requires an Array of epochs')

  const keys = epochs.map((epoch) => epoch.secret.toString('hex')).sort()

  const winningKey = Buffer.from(keys[0], 'hex')

  return epochs.find((epoch) => epoch.secret.equals(winningKey))
}

function reduceEpochs(ssb, groupId, opts = {}, cb) {
  const { getters } = opts
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

  pull(
    // collect epochs and decorate each epoch "node" with data (using getters)
    epochNodeStream(ssb, groupId, { getters }),
    pull.collect((err, nodes) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failure collecting epoch messages'))

      // reduce all of these epoch nodes with a tangle
      const reduce = new Reduce(strategy, { nodes })
      reduce.resolve()
      // INFO: this walks the graph and prunes disconnected nodes

      cb(null, reduce)
    })
  )
}
reduceEpochs.stream = function reduceEpochsStream(ssb, groupId, opts = {}) {
  const { getters, live } = opts
  const reduce = new Reduce(strategy)

  return pull(
    epochNodeStream(ssb, groupId, { getters, live }),
    pull.map((node) => {
      reduce.addNodes([node])
      reduce.resolve()
      return reduce
    })
  )
}

function epochNodeStream(ssb, groupId, opts = {}) {
  const { getters, live } = opts
  const deferredSource = pullDefer.source()

  getGroupInit(ssb, groupId, (err, root) => {
    // prettier-ignore
    if (err) return deferredSource.abort(clarify(err, 'Failed to get group init message'))

    // Take each root/update and build an epoch "node" for our tangle
    const source = pull(
      pull.values([
        pull.once(root),
        pull(
          getTangleUpdates.stream(ssb, 'epoch', toMsgURI(root.key), { live }),
          pull.filter(isInitEpoch)
        ),
      ]),
      pull.flatten(),
      pull.asyncMap((msg, cb) => {
        const epochRootId = toMsgURI(msg.key)
        const epochData = {}
        const node = {
          key: epochRootId,
          previous: msg.value.content.tangles.epoch.previous,
          data: {
            [epochRootId]: epochData,
          },
        }
        if (!getters) return cb(null, node)

        // Use getters to attach desired data to our epoch "node"
        pull(
          pull.values(Object.entries(getters)),
          pull.asyncMap(([fieldName, getter], cb) => {
            getter(msg, (err, fieldData) => {
              if (err)
                return cb(clarify(err, 'Failed to get epoch ' + fieldName))

              epochData[fieldName] = fieldData
              cb(null)
            })
          }),
          pull.collect((err) => {
            if (err) return cb(clarify(err, 'Failed to collect epoch data'))

            cb(null, node)
          })
        )
      })
    )

    deferredSource.resolve(source)
  })

  return deferredSource
}
function getGroupInit(ssb, groupId, cb) {
  ssb.box2.getGroupInfo(groupId, (err, info) => {
    // prettier-ignore
    if (err) return cb(clarify(err, 'Failed to get group info for ' + groupId))
    if (!info) return cb(new Error('Unknown group'))

    // Fetch the tangle root
    ssb.db.get(info.root, (err, rootVal) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to load group root with id ' + info.root))

      if (!isInitRoot(rootVal))
        // prettier-ignore
        return cb(clarify(new Error(isInitRoot.string), 'Malformed group/init root message'))

      cb(null, { key: info.root, value: rootVal })
    })
  })
}

/* HELPERS */
function buildPreferredEpoch(reduce, cb) {
  const tips = Object.keys(reduce.state).map((id) => {
    const info = {
      id,
      previous: reduce.graph.getNode(id).previous,
      ...reduce.state[id][id],
    }
    info.secret = Buffer.from(info.secret, 'base64')
    info.members = new Set(info.members.added)
    return info
  })

  let preferredEpoch
  if (tips.length === 1) preferredEpoch = tips[0]
  else if (tips.length === 2) {
    if (isSameSet(...tips.map((t) => t.members)))
      preferredEpoch = tieBreak(tips)
    else return cb(Error('case not handled yet'))
  } else return cb(Error(`case of ${tips.length} tips not handled yet`))

  delete preferredEpoch.members
  cb(null, preferredEpoch)
}

function toPattern(regexp) {
  return regexp.toString().replace(/^\//, '').replace(/\/$/, '')
}

function toMsgURI(id) {
  return id.startsWith('%') ? fromMessageSigil(id) : id
}

function pluck(obj, keys) {
  return keys.reduce((acc, key) => {
    acc[key] = obj[key]
    return acc
  }, {})
}

function isSameSet(a, b) {
  if (a.size !== b.size) return false

  for (const el of a) {
    if (!b.has(el)) return false
  }

  return true
}
