const { promisify: p } = require('util')
const { fromMessageSigil, fromFeedSigil } = require('ssb-uri2')

const Reduce = require('@tangle/reduce')
const Strategy = require('@tangle/strategy')
const OverwriteFields = require('@tangle/overwrite-fields')

const getTangleUpdates = require('./tangles/get-tangle-updates')

const msgPattern = [
  '^',
  'ssb:message',
  '/',
  '[a-zA-Z0-9-]+', // message "format"
  '/',
  '[a-zA-Z0-9-_]{43}=', // message "key"
  '$'
].join('')

const feedPattern = [
  '^',
  'ssb:feed',
  '/',
  '[a-zA-Z0-9-_]+', // feed "format"
  '/',
  '[a-zA-Z0-9-_]{43}=', // feed "key"
  '$'
].join('')

const strategy = new Strategy({
  epoch: OverwriteFields({
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
        pattern: '[a-zA-Z0-9/\\+]{43}=' // 32 bytes in base64
      }
    }
  })
})

module.exports = function Epochs (ssb) {
  function getEpochGraph (groupId, cb) {
    if (cb === undefined) return p(getEpochGraph)(groupId)

    ssb.box2.getGroupInfo(groupId, (err, info) => {
      if (err) return cb(err)

      ssb.db.get(info.root, (err, rootVal) => {
        if (err) return cb(err)
        // TODO check is a valid groupInitRoot
        const root = { key: info.root, value: rootVal }

        getTangleUpdates(ssb, 'epoch', info.root, (err, updates) => {
          if (err) return cb(err)
          // TODO filter updates usiny groupInitEpoch

          const nodes = [root, ...updates]
            .map(msg => {
              const key = toMsgURI(msg.key)
              return {
                key,
                previous: msg.value.content.tangles.epoch.previous,
                data: {
                  epoch: {
                    [key]: {
                      author: toFeedURI(msg.value.author),
                      epochKey: msg.value.content.groupKey
                    }
                  }
                }
              }
            })

          const reduce = new Reduce(strategy, { nodes })

          cb(null, reduce.state)
        })
      })
    })
  }

  return {
    getEpochGraph
  }
}

function toMsgURI (id) {
  if (id.startsWith('%')) return fromMessageSigil(id)
  else return id
}
function toFeedURI (id) {
  if (id.startsWith('@')) return fromFeedSigil(id)
  else return id
}
