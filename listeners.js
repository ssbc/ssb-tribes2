// SPDX-FileCopyrightText: 2023 Mix Irving <mix@protozoa.nz>
//
// SPDX-License-Identifier: LGPL-3.0-only
//

const {
  where,
  and,
  or,
  live,
  isDecrypted,
  type,
  toPullStream,
} = require('ssb-db2/operators')
const {
  validator: {
    group: {
      addMember: isAddMember,
      excludeMember: isExcludeMember,
      initEpoch: isInitEpoch,
    },
  },
  keySchemes,
} = require('private-group-spec')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const clarify = require('clarify-error')
const Epochs = require('./lib/epochs')
const { reAddMembers } = require('./lib/exclude')

// push a function to this list to have it called when the client is closing
const closeCalls = []

module.exports = function startListeners(ssb, config, onError) {
  const { getTipEpochs, getPreferredEpoch } = Epochs(ssb)

  let isClosed = false
  ssb.close.hook((close, args) => {
    isClosed = true
    close.apply(ssb, args)

    closeCalls.forEach((fn) => fn())
  })

  ssb.metafeeds.findOrCreate((err, myRoot) => {
    // prettier-ignore
    if (err) return onError(clarify(err, 'Error getting own root in start()'))

    // check if we've been excluded
    pull(
      ssb.db.query(
        where(and(isDecrypted('box2'), type('group/exclude-member'))),
        live({ old: true }),
        toPullStream()
      ),
      pull.filter(isExcludeMember),
      pull.filter((msg) =>
        // it's an exclusion of us
        msg.value.content.excludes.includes(myRoot.id)
      ),
      pull.drain(
        (msg) => {
          const groupId = msg.value.content.recps[0]
          getTipEpochs(groupId, (err, tipEpochs) => {
            // prettier-ignore
            if (err) return onError(clarify(err, 'Error on getting tip epochs after finding exclusion of ourselves'))

            const excludeEpochRootId = msg.value.content.tangles.members.root

            const excludeIsInTipEpoch = tipEpochs
              .map((tip) => tip.id)
              .includes(excludeEpochRootId)

            // ignore the exclude if it's an old one (we were added back to the group later)
            if (!excludeIsInTipEpoch) return

            ssb.box2.excludeGroupInfo(groupId, (err) => {
              // prettier-ignore
              if (err) return onError(clarify(err, 'Error on excluding group info after finding exclusion of ourselves'))
            })
          })
        },
        (err) => {
          // prettier-ignore
          if (err && !isClosed) return onError(clarify(err, 'Error on looking for exclude messages excluding us'))
        }
      )
    )

    // look for new epochs that we're added to
    pull(
      ssb.db.query(
        where(and(isDecrypted('box2'), type('group/add-member'))),
        live({ old: true }),
        toPullStream()
      ),
      pull.filter(isAddMember),
      // groups/epochs we're added to
      pull.filter((msg) => {
        return msg.value.content.recps.includes(myRoot.id)
      }),
      // to find new epochs we only check groups we've accepted the invite to
      paraMap((msg, cb) => {
        pull(
          ssb.box2.listGroupIds(),
          pull.filter((groupId) => groupId === msg.value.content.recps[0]),
          pull.take(1),
          pull.collect((err, groupIds) => {
            // prettier-ignore
            if (err) return cb(clarify(err, "Error getting groups we're already in when looking for new epochs"))
            cb(null, groupIds.length ? msg : null)
          })
        )
      }, 4),
      pull.filter(Boolean),
      pull.drain(
        (msg) => {
          const groupId = msg.value.content.recps[0]

          const secret = Buffer.from(msg.value.content.secret, 'base64')
          ssb.box2.addGroupInfo(groupId, { key: secret }, (err) => {
            // prettier-ignore
            if (err && !isClosed) return onError(clarify(err, 'Cannot add new epoch key that we found'))

            const newKeyPick = {
              key: secret,
              scheme: keySchemes.private_group,
            }
            // TODO: naively guessing that this is the latest key for now
            ssb.box2.pickGroupWriteKey(groupId, newKeyPick, (err) => {
              // prettier-ignore
              if (err && !isClosed) return onError(clarify(err, 'Error switching to new epoch key that we found'))

              ssb.db.reindexEncrypted((err) => {
                // prettier-ignore
                if (err && !isClosed) onError(clarify(err, 'Error reindexing after finding new epoch'))
              })
            })
          })
        },
        (err) => {
          // prettier-ignore
          if (err && !isClosed) return onError(clarify(err, "Error finding new epochs we've been added to"))
        }
      )
    )

    // listen for new epochs and update groupInfo as required
    pull(
      ssb.db.query(
        where(or(type('group/init'), type('group/add-member'))),
        live({ old: true }),
        toPullStream()
      ),
      pull.filter((msg) => isInitEpoch(msg) || isAddMember(msg)),
      pull.map((msg) => msg.value.content.recps[0]),
      pull.drain(
        (groupId) => {
          ssb.box2.getGroupInfo(groupId, (err, groupInfo) => {
            // prettier-ignore
            if (err && !isClosed) return onError(clarify(err, 'fatal error in live updating groupInfo'))
            if (!groupInfo) return // group that we've not accepted an invite to yet
            if (groupInfo.excluded) return // group where we were excluded

            getPreferredEpoch(groupId, (err, epochInfo) => {
              // prettier-ignore
              if (err && !isClosed) return onError(clarify(err, 'fatal error getting preferred epoch'))
              if (groupInfo.writeKey.key.equals(epochInfo.secret)) return

              ssb.box2.addGroupInfo(
                groupId,
                { key: epochInfo.secret },
                (err) => {
                  // prettier-ignore
                  if (err && !isClosed) return onError(clarify(err, 'Error adding new epoch key'))

                  const newKeyPick = {
                    key: epochInfo.secret,
                    scheme: keySchemes.private_group,
                  }
                  ssb.box2.pickGroupWriteKey(groupId, newKeyPick, (err) => {
                    // prettier-ignore
                    if (err && !isClosed) return onError(clarify(err, 'Error picking group write key'))

                    ssb.db.reindexEncrypted((err) => {
                      // prettier-ignore
                      if (err && !isClosed) onError(clarify(err, 'Error reindexing after finding new epoch'))
                    })
                  })
                }
              )
            })
          })
        },
        (err) => {
          // prettier-ignore
          if (err && !isClosed) return onError(clarify(err, 'Problem listening to new messages'))
        }
      )
    )

    // re-add missing people to a new epoch if the epoch creator didn't add everyone but they added us.
    // we're only doing this for the preferred epoch atm
    pull(
      ssb.tribes2.list({ live: true }),
      pull.unique('id'),
      pull.map((group) =>
        pull(
          getPreferredEpoch.stream(group.id, { live: true }),
          pull.drain(
            () => {
              const timeoutScale = config.tribes2?.timeoutScale ?? 1000
              const timeoutRandom = Math.random() * 30 + 1
              const randomTimeout = timeoutScale * timeoutRandom

              const timeoutId = setTimeout(() => {
                reAddMembers(ssb, group.id, null, (err) => {
                  // prettier-ignore
                  if (err && !isClosed) return onError(clarify(err, 'Failed re-adding members to epoch that missed some'))
                })
              }, randomTimeout)

              closeCalls.push(() => clearTimeout(timeoutId))
            },
            (err) => {
              // prettier-ignore
              if (err && !isClosed) return onError(clarify(err, "Failed finding new preferred epochs when looking for them to add missing members to"))
            }
          )
        )
      ),
      pull.drain(
        () => {},
        (err) => {
          // prettier-ignore
          if (err && !isClosed) return onError(clarify(err, 'Failed listing groups when trying to find epochs to re-add members to'))
        }
      )
    )
  })
}
