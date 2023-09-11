const { promisify: p } = require('util')
const pull = require('pull-stream')
const pullDefer = require('pull-defer')
const clarify = require('clarify-error')
const {
  validator: {
    group: { addMember: isAddMember, excludeMember: isExcludeMember },
  },
} = require('private-group-spec')
const { fromMessageSigil } = require('ssb-uri2')

const getTangleUpdates = require('../tangles/get-tangle-updates')

function toMsgURI(id) {
  return id.startsWith('%') ? fromMessageSigil(id) : id
}

module.exports = function GetMembers(ssb) {
  return getMembers

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
}
