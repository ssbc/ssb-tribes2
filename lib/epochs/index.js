// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify: p } = require('util')
const { fromMessageSigil } = require('ssb-uri2')
const pull = require('pull-stream')
const pullDefer = require('pull-defer')
const pullFlatMerge = require('pull-flat-merge')
const Strategy = require('@tangle/strategy')
const Reduce = require('@tangle/reduce')
const OverwriteFields = require('@tangle/overwrite-fields')
const clarify = require('clarify-error')
const Butt64 = require('butt64')
const isCanonicalBase64 = require('is-canonical-base64')
const { where, and, type, live, toPullStream } = require('ssb-db2/operators')
const {
  validator: {
    group: {
      initRoot: isInitRoot,
      initEpoch: isInitEpoch,
      addMember: isAddMember,
      // excludeMember: isExcludeMember,
    },
  },
} = require('private-group-spec')
const difference = require('set.prototype.difference')
const isSubsetOf = require('set.prototype.issubsetof')
const intersection = require('set.prototype.intersection')

const GetMembers = require('./get-members')

const { groupRecp } = require('../operators')
const hookClose = require('../hook-close')
const getTangleUpdates = require('../tangles/get-tangle-updates')

const msgPattern = toPattern(new Butt64('ssb:message/[a-zA-Z0-9-]+/', null, 32))
const feedPattern = toPattern(new Butt64('ssb:feed/[a-zA-Z0-9-]+/', null, 32))
const secretPattern = toPattern(isCanonicalBase64(null, null, 32))

// This strategy describes how to "reduce" the tangle of epochs and their data.
// Here OverwriteFields lets any link in the tangle contain Objects with form
// { [key]: value } so long as
//   - key matches msgPattern,
//   - value is { author, secret }
//
// Since each key is unique here this behaves like Object.assign (with checks)
const strategy = new Strategy({
  epoch: OverwriteFields({
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
      // required: ['author', 'secret'],
      // additionalProperties: false,
    },
  }),
})

function Getters(ssb) {
  const getMembers = GetMembers(ssb)

  return {
    author(epochRoot, cb) {
      ssb.metafeeds.findRootFeedId(epochRoot.value.author, cb)
    },
    secret(epochRoot, cb) {
      cb(null, epochRoot.value.content.secret)
    },
    members(epochRoot, cb) {
      getMembers(epochRoot.key, cb)
    },
  }
}

module.exports = function Epochs(ssb) {
  hookClose(ssb)
  const allGetters = Getters(ssb)

  // get all epochs that make up the history of the group
  function getEpochs(groupId, cb) {
    if (cb === undefined) return p(getEpochs)(groupId)

    const opts = { getters: pluck(allGetters, ['author', 'secret']) }
    epochsReduce(ssb, groupId, opts, (err, reduce) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      const epochs = reduce.graph.connectedNodes.map((node) => {
        const info = {
          id: node.key, // alias: epochRootId
          previous: node.previous,
          ...node.data.epoch[node.key],
        }
        info.secret = Buffer.from(info.secret, 'base64')
        return info
      })

      cb(null, epochs)
    })
  }

  // get just the epochs which are the "latest" / tips of the epoch graph of a group
  function getTipEpochs(groupId, cb) {
    if (cb === undefined) return p(getTipEpochs).call(this, groupId)

    const opts = { getters: pluck(allGetters, ['author', 'secret']) }
    epochsReduce(ssb, groupId, opts, (err, reduce) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      const tips = getTipsFromTangleReduce(reduce)
      return cb(null, tips)
    })
  }

  /**  Gets all epochs leading up to the specified epoch, all the way back to the root.
   * Does not include the specified epoch nor epochs in epoch forks.
   */
  function getPredecessorEpochs(groupId, epochRootId, cb) {
    if (cb === undefined)
      return p(this.getPredecessorEpochs).call(this, groupId, epochRootId)

    const opts = { getters: pluck(allGetters, ['author', 'secret']) }
    epochsReduce(ssb, groupId, opts, (err, reduce) => {
      // prettier-ignore
      if (err) return cb(clarify(err, "Couldn't get epoch reducer when getting predecessors"))

      const predecessors = reduce.graph.getHistory(epochRootId).map((id) => {
        const node = reduce.graph.getNode(id)
        const data = node.data.epoch[id]

        return {
          id,
          previous: node.previous,
          secret: Buffer.from(data.secret, 'base64'),
        }
      })

      return cb(null, predecessors)
    })
  }

  function getPreferredEpoch(groupId, cb) {
    if (cb === undefined) return p(getPreferredEpoch)(groupId)

    epochsReduce(ssb, groupId, { getters: allGetters }, (err, reduce) => {
      if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

      BuildPreferredEpoch(ssb, groupId)(reduce, cb)
    })
  }

  // prettier-ignore
  getPreferredEpoch.stream = function getPreferredEpochStream(groupId, opts = {}) {
    const { live } = opts

    const deferredSource = pullDefer.source()

    // we don't want to emit every epoch up till current, so we calculate the current,
    // then skip all the preferrentEpochs until we get up to the current
    // This is important for listMembers to not send confusing results
    getPreferredEpoch(groupId, (err, preferredEpoch) => {
      if (err) return deferredSource.abort(clarify(err, 'failed to get initial preferred epoch'))

      if (!live) {
        deferredSource.resolve(pull.once(preferredEpoch))
        return
      }

      var sync = false
      const source = pull(
        epochsReduce.stream(ssb, groupId, { getters: allGetters, live }),
        pull.asyncMap(BuildPreferredEpoch(ssb, groupId)),
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

    epochsReduce(ssb, groupId, { getters: allGetters }, (err, reduce) => {
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
              historyNode.data.epoch[historyNode.key].members
            added.forEach((feedId) => addedSoFar.add(feedId))

            if (historyNode.key === node.key) return
            // INFO node members toExclude is talking about what should happen
            // *after* it in the graph, so if we're enquiring about a
            // particular epoch, we don't include that epoch's toExclude
            toExclude.forEach((feedId) => excludedSoFar.add(feedId))
          })

        // Check if those who should be present are present
        const shouldBePresent = difference(addedSoFar, excludedSoFar)
        const currentMembers = new Set(node.data.epoch[node.key].members.added)
        if (isSameSet(shouldBePresent, currentMembers)) return acc

        // If find some missing, record this epoch and missing members
        acc.push({
          epoch: node.key, // alias: epochRootId
          secret: Buffer.from(node.data.epoch[node.key].secret, 'base64'),
          missing: [...difference(shouldBePresent, currentMembers)],
        })
        return acc
      }, [])

      cb(null, result)
    })
  }

  return {
    getEpochs,
    getTipEpochs,
    getPredecessorEpochs,
    getMembers: GetMembers(ssb),
    getPreferredEpoch,
    getMissingMembers,
    tieBreak,
  }
}

function epochsReduce(ssb, groupId, opts = {}, cb) {
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
// emits updated @tangle/reduce objects as changes occur to epoch graph
epochsReduce.stream = function epochsReduceStream(ssb, groupId, opts = {}) {
  const { getters, live: isLive } = opts
  const reduce = new Reduce(strategy)
  const getMembers = GetMembers(ssb)

  return pull(
    // reduce can be modified by 2 sorts of update:
    pull.values([
      // 1. new epochs as they're discovered
      pull(
        epochNodeStream(ssb, groupId, { getters, live }),
        pull.map((node) => {
          reduce.addNodes([node])
          return true
        })
      ),

      // 2. new member additions as discovered
      // NOTE membership can changed preferredEpoch
      pull(
        ssb.db.query(
          where(and(type('group/add-member'), groupRecp(groupId))),
          isLive ? live({ old: false }) : null,
          toPullStream()
        ),
        pull.filter(isAddMember),
        pull.asyncMap((msg, cb) => {
          const epochId = msg.value.content.tangles.members.root
          // check if this epoch is in the reduce tangle
          const epochNode = reduce.graph.getNode(epochId)
          if (!epochNode) return cb(null, false)

          getMembers(epochId, (err, res) => {
            if (err) return cb(null, false)
            epochNode.data.epoch[epochId].members = res
            cb(null, true)
          })
        })
      ),
    ]),
    pullFlatMerge(),
    pull.filter(),
    pull.map(() => {
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
        // Build epoch node
        const epochRootId = toMsgURI(msg.key)
        const epochData = {}
        const node = {
          key: epochRootId,
          previous: msg.value.content.tangles.epoch.previous,
          data: {
            epoch: {
              [epochRootId]: epochData,
            },
          },
        }
        if (!getters) return cb(null, node)

        // Use getters to attach desired data to our epoch node
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
function tieBreak(epochs) {
  if (!epochs || !Array.isArray(epochs))
    throw Error('tieBreak requires an Array of epochs')

  const keys = epochs.map((epoch) => epoch.secret.toString('hex')).sort()

  const winningKey = Buffer.from(keys[0], 'hex')

  return epochs.find((epoch) => epoch.secret.equals(winningKey))
}

function BuildPreferredEpoch(ssb, groupId) {
  return function buildPreferredEpoch(reduce, cb) {
    const tips = getTipsFromTangleReduce(reduce)

    var preferredEpoch
    if (tips.length === 1) preferredEpoch = tips[0]
    else if (tips.length === 2) {
      const [members0, members1] = tips.map((t) => t.members)

      // case 4.4 - same membership
      if (isSameSet(members0, members1)) {
        preferredEpoch = tieBreak(tips)
      }

      // case 4.5 - one group has a membership that's a subset of other
      else if (isSubsetOf(members0, members1)) {
        preferredEpoch = tips[0]
      } else if (isSubsetOf(members1, members0)) {
        preferredEpoch = tips[1]
      }

      // case 4.6 - groups have overlapping membership, but disjoint
      else if (intersection(members0, members1).size > 0) {
        // choose one for now,
        preferredEpoch = tieBreak(tips)
        // but also kick off resolution
        fixDisjointEpochsLater(ssb, groupId) // <<< DELAYED SIDE EFFECTS!
      } else {
        return cb(new Error('unknown membership case!'))
      }
      // case 4.7 - disjoint membership (no overlap!)
      // in this case peers should not even know about 2 distinct memberships
    } else return cb(Error(`case of ${tips.length} tips not handled yet`))

    if (preferredEpoch.members) delete preferredEpoch.members

    cb(null, preferredEpoch)
  }
}

// similar to getTipEpochs but a little slower because loading the membership of the epochs
// NOTE could optimise to just load the membership of ONLY the tips later :shrug:
function getTipEpochsWithMembers(ssb, groupId, cb) {
  if (cb === undefined)
    return p(getTipEpochsWithMembers).call(this, ssb, groupId)

  const opts = { getters: Getters(ssb) }
  epochsReduce(ssb, groupId, opts, (err, reduce) => {
    // prettier-ignore
    if (err) return cb(clarify(err, 'Failed to resolve epoch @tangle/reduce'))

    const tips = getTipsFromTangleReduce(reduce)
    return cb(null, tips)
  })
}

function fixDisjointEpochsLater(ssb, groupId) {
  const timeout =
    ssb?.config?.tribes2?.disjointResloveDelay ??
    (110 * Math.random() + 10) * 1000 // 10-120 seconds
  const timeoutId = setTimeout(() => {
    // check if disjoint still
    getTipEpochsWithMembers(ssb, groupId, (err, tips) => {
      if (err)
        return console.error(
          clarify(err, 'Failed to check disjoint but overlapping state')
        )

      if (!isDisjointOverlappingState(tips)) return

      // start resolving
      const preferredEpoch = tieBreak(tips)
      const otherEpoch = tips.find((tip) => tip.id !== preferredEpoch.id)
      const commonMembers = intersection(
        preferredEpoch.members,
        otherEpoch.members
      )
      const toExclude = new Set([])
      preferredEpoch.members.forEach((member) => {
        if (commonMembers.has(member)) return

        toExclude.add(member)
      })

      ssb.tribes2.excludeMembers(groupId, [...toExclude], {}, (err) => {
        if (err)
          console.error(
            clarify(err, 'Failed to resolve disjoint but overlapping state')
          )
      })
    })
  }, timeout)

  hookClose.onClose(() => clearTimeout(timeoutId))
}

function isDisjointOverlappingState(tips) {
  if (tips.length === 1) return false
  else if (tips.length === 2) {
    const [members0, members1] = tips.map((t) => t.members)

    if (
      // case 4.4
      isSameSet(members0, members1) ||
      // case 4.5
      isSubsetOf(members0, members1) ||
      isSubsetOf(members1, members0)
    )
      return false

    // case 4.6
    return intersection(members0, members1).size > 0
  } else {
    throw new Error(`case of ${tips.length} tips not handled yet`)
  }
}

function getTipsFromTangleReduce(reduce) {
  return Object.keys(reduce.state).map((id) => {
    const info = {
      id,
      previous: reduce.graph.getNode(id).previous,
      ...reduce.state[id].epoch[id],
    }
    info.secret = Buffer.from(info.secret, 'base64')
    if (info.members) {
      info.members = new Set(info.members.added)
    }
    return info
  })
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
