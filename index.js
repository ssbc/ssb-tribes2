// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify } = require('util')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const pullMany = require('pull-many')
const lodashGet = require('lodash.get')
const chunk = require('lodash.chunk')
const clarify = require('clarify-error')
const {
  where,
  and,
  isDecrypted,
  type,
  live,
  toPullStream,
} = require('ssb-db2/operators')
const {
  validator: {
    group: {
      addMember: isAddMember,
      content: isContent,
      exclude: isExclude,
      initEpoch: isInitEpoch,
    },
  },
  keySchemes,
} = require('private-group-spec')
const { SecretKey } = require('ssb-private-group-keys')
const { fromMessageSigil, isBendyButtV1FeedSSBURI } = require('ssb-uri2')
const buildGroupId = require('./lib/build-group-id')
const addTangles = require('./lib/tangles/add-tangles')
const publishAndPrune = require('./lib/prune-publish')
const MetaFeedHelpers = require('./lib/meta-feed-helpers')
const { groupRecp } = require('./lib/operators')
// const Epochs = require('./lib/epochs')

module.exports = {
  name: 'tribes2',
  manifest: {
    create: 'async',
    get: 'async',
    list: 'source',
    addMembers: 'async',
    excludeMembers: 'async',
    publish: 'async',
    listMemebers: 'source',
    listInvites: 'source',
    acceptInvite: 'async',
    start: 'async',
  },
  // eslint-disable-next-line no-unused-vars
  init(ssb, config) {
    const {
      secretKeyFromString,
      findOrCreateAdditionsFeed,
      findOrCreateGroupFeed,
      findOrCreateGroupWithoutMembers,
      getRootFeedIdFromMsgId,
    } = MetaFeedHelpers(ssb)
    // const { getEpochs } = Epochs(ssb)

    function create(opts = {}, cb) {
      if (cb === undefined) return promisify(create)(opts)

      findOrCreateGroupWithoutMembers((err, group) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to create group init message when creating a group'))

        const { groupInitMsg, groupFeed, myRoot } = group

        const secret = secretKeyFromString(groupFeed.purpose)

        const data = {
          id: buildGroupId({
            groupInitMsg,
            groupKey: secret.toBuffer(),
          }),
          writeKey: {
            key: secret.toBuffer(),
            scheme: keySchemes.private_group,
          },
          readKeys: [
            { key: secret.toBuffer(), scheme: keySchemes.private_group },
          ],
          root: fromMessageSigil(groupInitMsg.key),
          subfeed: groupFeed.keys,
        }

        ssb.box2.addGroupInfo(data.id, {
          key: data.writeKey.key,
          root: data.root,
        })

        // Adding myself for recovery reasons
        addMembers(data.id, [myRoot.id], {}, (err) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to add myself to the group when creating a group'))

          return cb(null, data)
        })
      })
    }

    function get(id, cb) {
      if (cb === undefined) return promisify(get)(id)

      ssb.box2.getGroupInfo(id, (err, info) => {
        if (err) return cb(clarify(err, 'Failed to get group details'))

        if (!info) return cb(new Error(`Couldn't find group with id ${id}`))

        cb(null, {
          ...info,
          id,
        })
      })
    }

    function list(opts = {}) {
      return pull(
        ssb.box2.listGroupIds({
          live: !!opts.live,
          excluded: !!opts.excluded,
        }),
        paraMap(get, 4)
      )
    }

    function addMembers(groupId, feedIds, opts = {}, cb) {
      if (cb === undefined) return promisify(addMembers)(groupId, feedIds, opts)

      if (!feedIds || feedIds.length === 0) {
        return cb(new Error('No feedIds provided to addMembers'))
      }
      if (feedIds.length > 15) {
        // prettier-ignore
        return cb(new Error(`Tried to add ${feedIds.length} members, the max is 15`))
      }
      if (feedIds.some((id) => !isBendyButtV1FeedSSBURI(id))) {
        return cb(new Error('addMembers only supports bendybutt-v1 feed IDs'))
      }

      get(groupId, (err, { writeKey, root }) => {
        // prettier-ignore
        if (err) return cb(clarify(err, `Failed to get group details when adding members`))

        getRootFeedIdFromMsgId(root, (err, rootAuthorId) => {
          // prettier-ignore
          if (err) return cb(clarify(err, "couldn't get root id of author of root msg"))

          const content = {
            type: 'group/add-member',
            version: 'v2',
            groupKey: writeKey.key.toString('base64'),
            root,
            creator: rootAuthorId,
            recps: [groupId, ...feedIds],
          }

          if (opts.text) content.text = opts.text

          const getFeed = opts?._feedKeys
            ? (cb) => cb(null, { keys: opts._feedKeys })
            : findOrCreateAdditionsFeed

          getFeed((err, additionsFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find or create additions feed when adding members'))

            const options = {
              isValid: isAddMember,
              tangles: ['members'],
              feedKeys: additionsFeed.keys,
            }
            publish(content, options, (err, msg) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed to publish add-member message'))
              return cb(null, msg)
            })
          })
        })
      })
    }

    function excludeMembers(groupId, feedIds, opts = {}, cb) {
      if (cb === undefined)
        return promisify(excludeMembers)(groupId, feedIds, opts)

      ssb.metafeeds.findOrCreate(function gotRoot(err, myRoot) {
        // prettier-ignore
        if (err) return cb(clarify(err, "Couldn't get own root when excluding members"))

        const excludeContent = {
          type: 'group/exclude',
          excludes: feedIds,
          recps: [groupId],
        }
        const excludeOpts = {
          tangles: ['members'],
          isValid: isExclude,
        }
        publish(excludeContent, excludeOpts, (err) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to publish exclude msg'))

          pull(
            listMembers(groupId),
            pull.collect((err, beforeMembers) => {
              // prettier-ignore
              if (err) return cb(clarify(err, "Couldn't get old member list when excluding members"))

              const remainingMembers = beforeMembers.filter(
                (member) => !feedIds.includes(member)
              )
              const newGroupKey = new SecretKey()
              const addInfo = { key: newGroupKey.toBuffer() }

              ssb.box2.addGroupInfo(groupId, addInfo, (err) => {
                // prettier-ignore
                if (err) return cb(clarify(err, "Couldn't store new key when excluding members"))

                const newKey = {
                  key: newGroupKey.toBuffer(),
                  scheme: keySchemes.private_group,
                }
                ssb.box2.pickGroupWriteKey(groupId, newKey, (err) => {
                  // prettier-ignore
                  if (err) return cb(clarify(err, "Couldn't switch to new key for writing when excluding members"))

                  const newEpochContent = {
                    type: 'group/init',
                    version: 'v2',
                    groupKey: newGroupKey.toString('base64'),
                    tangles: {
                      members: { root: null, previous: null },
                    },
                    recps: [groupId, myRoot.id],
                  }
                  const newTangleOpts = {
                    tangles: ['epoch'],
                    isValid: isInitEpoch,
                  }
                  publish(newEpochContent, newTangleOpts, (err) => {
                    // prettier-ignore
                    if (err) return cb(clarify(err, "Couldn't post init msg on new epoch when excluding members"))

                    pull(
                      pull.values(chunk(remainingMembers, 15)),
                      pull.asyncMap((membersToAdd, cb) =>
                        addMembers(groupId, membersToAdd, {}, cb)
                      ),
                      pull.collect((err) => {
                        // prettier-ignore
                        if (err) return cb(clarify(err, "Couldn't re-add remaining members when excluding members"))

                        return cb()
                      })
                    )
                  })
                })
              })
            })
          )
        })
      })
    }

    function publish(content, opts, cb) {
      if (cb === undefined) return promisify(publish)(content, opts)

      if (!content) return cb(new Error('Missing content'))

      const isValid = opts?.isValid ?? isContent
      const tangles = ['group', ...(opts?.tangles ?? [])]

      const recps = content.recps
      if (!recps || !Array.isArray(recps) || recps.length < 1) {
        return cb(new Error('Missing recps'))
      }
      const groupId = recps[0]

      get(groupId, (err, { writeKey, excluded }) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to get group details when publishing to a group'))

        if (excluded)
          return cb(
            new Error("Cannot publish to a group we've been excluded from")
          )

        addTangles(ssb, content, tangles, (err, content) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to add group tangle when publishing to a group'))

          if (!isValid(content))
            return cb(
              new Error(isValid.errorsString ?? 'content failed validation')
            )

          const getFeed = opts?.feedKeys
            ? (_, cb) => cb(null, { keys: opts.feedKeys })
            : findOrCreateGroupFeed

          getFeed(writeKey.key, (err, groupFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find or create group feed when publishing to a group'))

            publishAndPrune(ssb, content, groupFeed.keys, (err, msg) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed to publishAndPrune when publishing a group message'))
              return cb(null, msg)
            })
          })
        })
      })
    }

    function listMembers(groupId, opts = {}) {
      return pull(
        pull.values([0]),
        pull.asyncMap((n, cb) => {
          get(groupId, (err, group) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to get group info when listing members'))

            if (group.excluded) {
              return cb(
                new Error("We're excluded from this group, can't list members")
              )
            } else {
              const source = pull(
                ssb.db.query(
                  where(
                    and(
                      isDecrypted('box2'),
                      type('group/add-member'),
                      groupRecp(groupId)
                    )
                  ),
                  opts.live ? live({ old: true }) : null,
                  toPullStream()
                ),
                pull.map((msg) => msg.value.content.recps.slice(1)),
                pull.flatten(),
                pull.unique()
              )
              return cb(null, source)
            }
          })
        }),
        pull.flatten()
      )
    }

    function listInvites() {
      return pull(
        pull.values([0]), // dummy value used to kickstart the stream
        pull.asyncMap((n, cb) => {
          ssb.metafeeds.findOrCreate((err, myRoot) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to get root metafeed when listing invites'))

            pull(
              pullMany([
                ssb.box2.listGroupIds(),
                ssb.box2.listGroupIds({ excluded: true }),
              ]),
              pull.flatten(),
              pull.collect((err, groupIds) => {
                // prettier-ignore
                if (err) return cb(clarify(err, 'Failed to list group IDs when listing invites'))

                const source = pull(
                  ssb.db.query(
                    where(and(isDecrypted('box2'), type('group/add-member'))),
                    toPullStream()
                  ),
                  pull.filter((msg) =>
                    // it's an addition of us
                    lodashGet(msg, 'value.content.recps', []).includes(
                      myRoot.id
                    )
                  ),
                  pull.filter(
                    (msg) =>
                      // we haven't already accepted the addition
                      !groupIds.includes(
                        lodashGet(msg, 'value.content.recps[0]')
                      )
                  ),
                  pull.map((msg) => {
                    const key = Buffer.from(
                      lodashGet(msg, 'value.content.groupKey'),
                      'base64'
                    )
                    const scheme = keySchemes.private_group
                    return {
                      id: lodashGet(msg, 'value.content.recps[0]'),
                      writeKey: { key, scheme },
                      readKeys: [{ key, scheme }],
                      root: lodashGet(msg, 'value.content.root'),
                    }
                  })
                )

                return cb(null, source)
              })
            )
          })
        }),
        pull.flatten()
      )
    }

    function acceptInvite(groupId, cb) {
      if (cb === undefined) return promisify(acceptInvite)(groupId)

      let foundInvite = false
      pull(
        listInvites(),
        pull.filter((groupInfo) => groupInfo.id === groupId),
        pull.take(1),
        pull.drain(
          (groupInfo) => {
            foundInvite = true
            ssb.box2.addGroupInfo(
              groupInfo.id,
              {
                key: groupInfo.writeKey.key,
                root: groupInfo.root,
              },
              (err) => {
                // prettier-ignore
                if (err) return cb(clarify(err, 'Failed to add group info when accepting an invite'))
                ssb.db.reindexEncrypted((err) => {
                  // prettier-ignore
                  if (err) cb(clarify(err, 'Failed to reindex encrypted messages when accepting an invite'))
                  else cb(null, groupInfo)
                })
              }
            )
          },
          (err) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to list invites when accepting an invite'))
            // prettier-ignore
            if (!foundInvite) return cb(new Error("Didn't find invite for that group id"))
          }
        )
      )
    }

    function start(cb) {
      if (cb === undefined) return promisify(start)()

      findOrCreateAdditionsFeed((err) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Error finding or creating additions feed when starting ssb-tribes2'))
        return cb()
      })

      ssb.metafeeds.findOrCreate((err, myRoot) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Error getting own root in start()'))

        // check if we've been excluded
        pull(
          ssb.db.query(
            where(and(isDecrypted('box2'), type('group/exclude'))),
            live({ old: true }),
            toPullStream()
          ),
          pull.filter(isExclude),
          pull.filter((msg) =>
            // it's an exclusion of us
            msg.value.content.excludes.includes(myRoot.id)
          ),
          pull.drain(
            (msg) => {
              const groupId = msg.value.content.recps[0]
              ssb.box2.excludeGroupInfo(groupId, null)
            },
            (err) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Error on looking for exclude messages excluding us'))
            }
          )
        )

        // look for new epochs that we're added to
        pull(
          ssb.db.query(
            // TODO: does this output new stuff if we accept an invite to an old epoch and then find additions to newer epochs?
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
              pull.collect((err, groupIds) => {
                // prettier-ignore
                if (err) return cb(clarify(err, "Error getting groups we're already in when looking for new epochs"))

                if (groupIds.includes(msg.value.content.recps[0])) {
                  return cb(null, msg)
                } else {
                  return cb()
                }
              })
            )
          }, 4),
          pull.filter(Boolean),
          pull.drain(
            (msg) => {
              const groupId = msg.value.content.recps[0]

              const newKey = Buffer.from(msg.value.content.groupKey, 'base64')
              ssb.box2.addGroupInfo(groupId, { key: newKey }, (err) => {
                // prettier-ignore
                if (err) return cb(clarify(err, 'Error adding new epoch key that we found'))

                const newKeyPick = {
                  key: newKey,
                  scheme: keySchemes.private_group,
                }
                // TODO: naively guessing that this is the latest key for now
                ssb.box2.pickGroupWriteKey(groupId, newKeyPick, (err) => {
                  // prettier-ignore
                  if (err) return cb(clarify(err, 'Error switching to new epoch key that we found'))

                  ssb.db.reindexEncrypted((err) => {
                    // prettier-ignore
                    if (err) cb(clarify(err, 'Error reindexing after finding new epoch'))
                  })
                })
              })
            },
            (err) => {
              // prettier-ignore
              if (err) return cb(clarify(err, "Error finding new epochs we've been added to"))
            }
          )
        )
      })
    }

    return {
      create,
      get,
      list,
      addMembers,
      excludeMembers,
      publish,
      listMembers,
      listInvites,
      acceptInvite,
      start,
    }
  },
}
