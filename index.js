// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify } = require('util')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const lodashGet = require('lodash.get')
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
    group: { addMember: isAddMember, content: isContent },
  },
  keySchemes,
} = require('private-group-spec')
const { SecretKey } = require('ssb-private-group-keys')
const { fromMessageSigil, isBendyButtV1FeedSSBURI } = require('ssb-uri2')
const buildGroupId = require('./lib/build-group-id')
const AddTangles = require('./lib/add-tangles')
const publishAndPrune = require('./lib/prune-publish')
const MetaFeedHelpers = require('./lib/meta-feed-helpers')

module.exports = {
  name: 'tribes2',
  manifest: {
    create: 'async',
    publish: 'async',
    list: 'source',
    addMembers: 'async',
    start: 'async',
  },
  // eslint-disable-next-line no-unused-vars
  init(ssb, config) {
    const addTangles = AddTangles(ssb)
    const {
      secretKeyFromString,
      findOrCreateAdditionsFeed,
      findOrCreateGroupFeed,
      findOrCreateEpochWithoutMembers,
      getRootFeedIdFromMsgId,
    } = MetaFeedHelpers(ssb)

    function create(opts = {}, cb) {
      if (cb === undefined) return promisify(create)(opts)

      findOrCreateEpochWithoutMembers((err, group) => {
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
      return pull(ssb.box2.listGroupIds({ live: !!opts.live }), paraMap(get, 4))
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

          if (opts.feedKeys) {
            const options = {
              spec: isAddMember,
              tangles: ['members'],
              feedKeys: opts.feedKeys,
            }
            publish(content, options, (err, msg) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed to publish add-member message'))
              return cb(null, msg)
            })
            return
          }

          findOrCreateAdditionsFeed((err, additionsFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find or create additions feed when adding members'))
            const options = {
              spec: isAddMember,
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

        get(groupId, (err, { writeKey: oldWriteKey }) => {
          // prettier-ignore
          if (err) return cb(clarify(err, "Couldn't get old key when excluding members"))

          findOrCreateGroupFeed(oldWriteKey.key, (err, oldGroupFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, "Couldn't get the old group feed when excluding members"))

            const excludeContent = {
              type: 'group/exclude',
              excludes: feedIds,
              recps: [groupId],
            }
            const excludeOpts = {
              tangles: ['members'],
              spec: () => true,
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
                        spec: () => true,
                      }
                      publish(newEpochContent, newTangleOpts, (err) => {
                        // prettier-ignore
                        if (err) return cb(clarify(err, "Couldn't post init msg on new epoch when excluding members"))

                        const reAddOpts = {
                          // the re-adding needs to be published on the old
                          // feed so that the additions feed is not spammed,
                          // while people need to still be able to find it
                          feedKeys: oldGroupFeed.keys,
                        }
                        addMembers(
                          groupId,
                          remainingMembers,
                          reAddOpts,
                          (err) => {
                            // prettier-ignore
                            if (err) return cb(clarify(err, "Couldn't re-add remaining members when excluding members"))
                            return cb()
                          }
                        )
                      })
                    })
                  })
                })
              )
            })
          })
        })
      })
    }

    function publish(content, opts = {}, cb) {
      if (cb === undefined) return promisify(publish)(content, opts)

      if (!content) return cb(new Error('Missing content'))

      const isSpec = opts?.spec ?? isContent
      const tangles = ['group', ...(opts?.tangles ?? [])]

      const recps = content.recps
      if (!recps || !Array.isArray(recps) || recps.length < 1) {
        return cb(new Error('Missing recps'))
      }
      const groupId = recps[0]

      addTangles(content, tangles, (err, content) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to add group tangle when publishing to a group'))

        if (!isSpec(content)) return cb(new Error(isSpec.errorsString))

        get(groupId, (err, { writeKey }) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to get group details when publishing to a group'))

          if (opts.feedKeys) {
            publishAndPrune(ssb, content, opts.feedKeys, (err, msg) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed to publishAndPrune when publishing a group message'))
              return cb(null, msg)
            })
            return
          }

          findOrCreateGroupFeed(writeKey.key, (err, groupFeed) => {
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
        ssb.db.query(
          where(and(isDecrypted('box2'), type('group/add-member'))),
          opts.live ? live({ old: true }) : null,
          toPullStream()
        ),
        pull.map((msg) => lodashGet(msg, 'value.content.recps', [])),
        pull.filter((recps) => recps.length > 1 && recps[0] === groupId),
        pull.map((recps) => recps.slice(1)),
        pull.flatten(),
        pull.unique()
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
              ssb.box2.listGroupIds(),
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
