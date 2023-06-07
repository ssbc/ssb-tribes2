// SPDX-FileCopyrightText: 2023 Mix Irving <mix@protozoa.nz>
//
// SPDX-License-Identifier: LGPL-3.0-only

const {
  where,
  and,
  or,
  live: dbLive,
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
const { reAddMembers, createNewEpoch } = require('./lib/exclude')

// push a function to this list to have it called when the client is closing
const closeCalls = []

function randomTimeout(config) {
  if (!config) throw new Error('Please give config')
  const timeoutLow = config.tribes2?.timeoutLow ?? 5
  const timeoutHigh = config.tribes2?.timeoutHigh ?? 30
  if (timeoutHigh < timeoutLow)
    throw new Error('timeoutHigh must be > timeoutLow')
  const timeoutRandom = Math.random() * (timeoutHigh - timeoutLow) + timeoutLow
  return timeoutRandom * 1000
}

module.exports = function startListeners(ssb, config, onError) {
  const { getTipEpochs, getPreferredEpoch, getMissingMembers } = Epochs(ssb)

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
        dbLive({ old: true }),
        toPullStream()
      ),
      pull.filter(isExcludeMember),
      pull.drain(
        (msg) => {
          handleMyExclusion(msg.value.content)
          handleCrashedExclusion(msg.value.content)
        },
        (err) => {
          // prettier-ignore
          if (err && !isClosed) return onError(clarify(err, 'Error on looking for exclude messages excluding us'))
        }
      )
    )
    function handleMyExclusion({ excludes, recps, tangles }) {
      // skip if it's NOT excluding us
      if (!excludes.includes(myRoot.id)) return

      const groupId = recps[0]
      const excludeEpochRootId = tangles.members.root

      getTipEpochs(groupId, (err, tipEpochs) => {
        // prettier-ignore
        if (err) return onError(clarify(err, 'Error on getting tip epochs after finding exclusion of ourselves'))

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
    }

    // TEMP
    function log(...args) {
      if (ssb.name !== 'carol') return
      console.log(...args)
    }
    // NOTE this method will be called for EACH exclusion discovered
    // could make startup slow
    function handleCrashedExclusion({ excludes, recps, tangles }) {
      // skip if it's excluding us
      if (excludes.includes(myRoot.id)) return

      const groupId = recps[0]
      // current epoch being checked
      const currentEpochId = tangles.members.root

      // after a random wait, check if there's a newer epoch
      const ensureExclusionComplete = () => {
        log('running checks: preferredEpoch')
        getPreferredEpoch(groupId, (err, preferredEpoch) => {
          // prettier-ignore
          if (err) return onError(clarify(err, 'Error getting preferredEpoch while trying to check if exclusion was successful'))

          // if there is no newer epoch, we should complete the exclusion by creating one
          log('epochs', {
            preferred: preferredEpoch.id,
            current: currentEpochId,
          })
          if (preferredEpoch.id === currentEpochId) {
            log('running createNewEpoch D:') // THIS SHOULD NOT BE HAPPENING IN ONLY TEST ATM
            createNewEpoch(ssb, groupId, null, (err) => {
              // prettier-ignore
              if (err && !isClosed) return onError(clarify(err, "Couldn't create new epoch to recover from a missing one"))
            })
            return
          }

          // if there was a newer epoch, check the membership is correct
          // TODO technically, we should check this preferredEpoch is a descendant of the currentEpoch
          log('running reAddMember :D')
          reAddMembers(ssb, groupId, null, (err) => {
            if (err) onError(clarify(err, 're-add of members failed'))
          })
        })
      }
      const timeout = randomTimeout(config)
      log('setTimout reAddMembers', timeout)
      const timeoutId = setTimeout(ensureExclusionComplete, timeout)

      closeCalls.push(() => clearTimeout(timeoutId))
    }

    // listen for new epochs and update groupInfo as required
    pull(
      ssb.db.query(
        where(or(type('group/init'), type('group/add-member'))),
        dbLive({ old: true }),
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
  })
}
