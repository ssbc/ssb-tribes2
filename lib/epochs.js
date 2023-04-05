const { promisify: p } = require('util')
const { fromMessageSigil, fromFeedSigil } = require('ssb-uri2')
const pull = require('pull-stream')
const Reduce = require('@tangle/reduce')
const OverwriteFields = require('@tangle/overwrite-fields')
const Butt64 = require('butt64')
const isCanonicalBase64 = require('is-canonical-base64')
const {
  validator: {
    group: {
      initRoot: isInitRoot,
      initEpoch: isInitEpoch
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

  return {
    getEpochs,
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
  if (id.startsWith('%')) return fromMessageSigil(id)
  else return id
}
function toFeedURI (id) {
  if (id.startsWith('@')) return fromFeedSigil(id)
  else return id
}
