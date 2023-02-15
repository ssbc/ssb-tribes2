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
  count,
  isDecrypted,
  type,
  live,
  author,
  toCallback,
  toPullStream,
} = require('ssb-db2/operators')
const {
  keySchemes,
  validator: {
    group: { init: initSpec, addMember: addMemberSpec },
  },
} = require('private-group-spec')
const { SecretKey } = require('ssb-private-group-keys')
const { fromMessageSigil, isBendyButtV1FeedSSBURI } = require('ssb-uri2')
const buildGroupId = require('./lib/build-group-id')
const AddGroupTangle = require('./lib/add-group-tangle')
const publishAndPrune = require('./lib/prune-publish')

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
    const addGroupTangle = AddGroupTangle(ssb)

    function findOrCreateAdditionsFeed(cb) {
      const details = {
        purpose: 'group/additions',
        feedFormat: 'classic',
      }

      ssb.metafeeds.findOrCreate(details, cb)
    }

    function findEmptyGroupFeed(rootId, cb) {
      let found = false
      pull(
        ssb.metafeeds.branchStream({ root: rootId, old: true, live: false }),
        pull.filter((branch) => branch.length === 4),
        pull.map((branch) => branch[3]),
        // only grab feeds that look like group feeds
        pull.filter((feed) => feed.recps && feed.purpose.length === 44),
        paraMap((feed, cb) => {
          ssb.db.query(
            where(author(feed.id)),
            count(),
            toCallback((err, count) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed to count messages in group feed'))

              if (count === 0) {
                // we're only interested in empty feeds
                return cb(null, feed)
              } else {
                return cb()
              }
            })
          )
        }),
        pull.filter(),
        pull.unique('id'),
        pull.take(1),
        pull.drain(
          (emptyFeed) => {
            found = true
            return cb(null, emptyFeed)
          },
          (err) => {
            if (err) cb(clarify(err, 'Failed to find empty group feed'))
            if (!found) cb()
          }
        )
      )
    }

    function findOrCreateFromSecret(secret, rootId, cb) {
      const recps = [
        { key: secret.toBuffer(), scheme: keySchemes.private_group },
        // encrypt to myself to be able to get back to the group without finding the group/add-member for me (maybe i crashed before adding myself)
        rootId,
      ]

      const groupFeedDetails = {
        purpose: secret.toString(),
        feedFormat: 'classic',
        recps,
        encryptionFormat: 'box2',
      }

      ssb.metafeeds.findOrCreate(groupFeedDetails, (err, groupFeed) => {
        if (err) return cb(clarify(err, 'Failed to find or create group feed'))
        cb(null, groupFeed)
      })
    }

    function findOrCreateGroupFeed(input = null, cb) {
      const inputSecret = Buffer.isBuffer(input) ? new SecretKey(input) : input

      ssb.metafeeds.findOrCreate(function gotRoot(err, root) {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to find or create root feed when finding or creating group feed'))

        // 1. publish. we know the secret and should just findOrCreate the feed
        // 2. create. we don't have a secret yet but can make or find one
        //   2.1. try to find an empty feed in case we've crashed before. use the secret from that one
        //   2.2. if we can't find an empty feed, make a new secret and findOrCreate

        if (inputSecret) {
          return findOrCreateFromSecret(inputSecret, root.id, cb)
        } else {
          findEmptyGroupFeed(root.id, (err, emptyFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find empty group feed when finding or creating a group'))

            if (emptyFeed) {
              return cb(null, emptyFeed)
            } else {
              const newSecret = new SecretKey()
              findOrCreateFromSecret(newSecret, root.id, cb)
            }
          })
        }
      })
    }

    function secretKeyFromPurpose(purpose) {
      return new SecretKey(Buffer.from(purpose, 'base64'))
    }

    function createGroupWithoutMembers(myRoot, cb) {
      const content = {
        type: 'group/init',
        tangles: {
          group: { root: null, previous: null },
        },
      }
      if (!initSpec(content)) return cb(new Error(initSpec.errorsString))

      findOrCreateGroupFeed(null, function gotGroupFeed(err, groupFeed) {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to find or create group feed when creating a group'))

        const secret = secretKeyFromPurpose(groupFeed.purpose)

        const recps = [
          { key: secret.toBuffer(), scheme: keySchemes.private_group },
          myRoot.id,
        ]

        ssb.db.create(
          {
            keys: groupFeed.keys,
            content,
            recps,
            encryptionFormat: 'box2',
          },
          (err, groupInitMsg) => {
            // prettier-ignore
            if (err) return cb(clarify(err, "couldn't create group root message"))
            return cb(null, { groupInitMsg, groupFeed, myRoot })
          }
        )
      })
    }

    /** more specifically: a group that has never had any members. i.e. either
     * 1. newly created but tribes2 crashed before we had time to add ourselves to it. in that case find and return it. if we can't find such a group then
     * 2. freshly create a new group, and return */
    function findOrCreateGroupWithoutMembers(cb) {
      ssb.metafeeds.findOrCreate(function gotRoot(err, myRoot) {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to find or create root feed when creating a group'))

        // find groups without any group/add-member messages
        let foundMemberlessGroup = false
        pull(
          ssb.db.query(
            where(and(isDecrypted('box2'), type('group/init'))),
            toPullStream()
          ),
          pull.asyncMap((rootMsg, cb) => {
            let foundMember = false
            pull(
              ssb.db.query(
                where(and(isDecrypted('box2'), type('group/add-member'))),
                toPullStream()
              ),
              pull.filter(
                (msg) =>
                  msg?.value?.content?.root === fromMessageSigil(rootMsg.key)
              ),
              pull.take(1),
              pull.drain(
                () => {
                  foundMember = true
                  return cb(null, false)
                },
                (err) => {
                  if (err) return cb(err)
                  else if (!foundMember) cb(null, rootMsg)
                }
              )
            )
          }),
          pull.filter(Boolean),
          pull.take(1),
          pull.drain(
            (rootMsg) => {
              foundMemberlessGroup = true
              ssb.metafeeds.advanced.findById(
                rootMsg.value.author,
                (err, groupFeed) => {
                  // prettier-ignore
                  if (err) return cb(clarify(err, "failed finding details of the memberless group feed"))

                  rootMsg.value.content = rootMsg.meta.originalContent
                  return cb(null, {
                    groupInitMsg: rootMsg,
                    groupFeed,
                    myRoot,
                  })
                }
              )
            },
            (err) => {
              // prettier-ignore
              if (err) return cb(clarify(err, "errored trying to find potential memberless feed"))
              else if (!foundMemberlessGroup) {
                return createGroupWithoutMembers(myRoot, cb)
              }
            }
          )
        )
      })
    }

    function create(opts = {}, cb) {
      if (cb === undefined) return promisify(create)(opts)

      findOrCreateGroupWithoutMembers(
        (err, { groupInitMsg, groupFeed, myRoot }) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to create group init message when creating a group'))

          const secret = secretKeyFromPurpose(groupFeed.purpose)

          const data = {
            id: buildGroupId({
              groupInitMsg,
              groupKey: secret.toBuffer(),
            }),
            secret: secret.toBuffer(),
            root: fromMessageSigil(groupInitMsg.key),
            subfeed: groupFeed.keys,
          }

          ssb.box2.addGroupInfo(data.id, {
            key: data.secret,
            root: data.root,
          })

          // Adding myself for recovery reasons
          addMembers(data.id, [myRoot.id], {}, (err) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to add myself to the group when creating a group'))

            return cb(null, data)
          })
        }
      )
    }

    function get(id, cb) {
      if (cb === undefined) return promisify(get)(id)

      ssb.box2.getGroupKeyInfo(id, (err, info) => {
        if (err) return cb(clarify(err, 'Failed to get group details'))

        if (!info) return cb(new Error(`Couldn't find group with id ${id}`))

        cb(null, {
          id,
          secret: info.key,
          root: info.root,
        })
      })
    }

    function list(opts = {}) {
      return pull(ssb.box2.listGroupIds({ live: !!opts.live }), paraMap(get, 4))
    }

    function getRootIdOfMsgAuthor(groupRootMsgId, cb) {
      ssb.db.get(groupRootMsgId, (err, rootMsg) => {
        // prettier-ignore
        if (err) return cb(clarify(err, "couldn't get root msg for finding root feed"))

        ssb.metafeeds.findRootFeedId(rootMsg.author, (err, rootFeedId) => {
          // prettier-ignore
          if (err) return cb(clarify(err, "couldn't find root feed id from root msg author"))

          return cb(null, rootFeedId)
        })
      })
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

      get(groupId, (err, { secret, root }) => {
        // prettier-ignore
        if (err) return cb(clarify(err, `Failed to get group details when adding members`))

        getRootIdOfMsgAuthor(root, (err, rootAuthorId) => {
          // prettier-ignore
          if (err) return cb(clarify(err, "couldn't get root id of author of root msg"))

          const content = {
            type: 'group/add-member',
            version: 'v2',
            groupKey: secret.toString('base64'),
            root,
            creator: rootAuthorId,
            tangles: {
              members: {
                root,
                previous: [root], // TODO calculate previous for members tangle
              },
              // likely incorrect group tangle and this will be overwritten by
              // publish(), we just add it here to make the spec pass
              group: {
                root,
                previous: [root],
              },
            },
            recps: [groupId, ...feedIds],
          }

          if (opts.text) content.text = opts.text

          if (!addMemberSpec(content))
            return cb(new Error(addMemberSpec.errorsString))

          findOrCreateAdditionsFeed((err, additionsFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find or create additions feed when adding members'))

            addGroupTangle(content, (err, content) => {
              // prettier-ignore
              if (err) return cb(clarify(err, 'Failed to add group tangle when adding members'))

              publishAndPrune(ssb, content, additionsFeed.keys, cb)
            })
          })
        })
      })
    }

    function publish(content, cb) {
      if (cb === undefined) return promisify(publish)(content)

      if (!content) return cb(new Error('Missing content'))

      const recps = content.recps
      if (!recps || !Array.isArray(recps) || recps.length < 1) {
        return cb(new Error('Missing recps'))
      }
      const groupId = recps[0]

      addGroupTangle(content, (err, content) => {
        // prettier-ignore
        if (err) return cb(clarify(err, 'Failed to add group tangle when publishing to a group'))

        get(groupId, (err, { secret }) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to get group details when publishing to a group'))

          findOrCreateGroupFeed(secret, (err, groupFeed) => {
            // prettier-ignore
            if (err) return cb(clarify(err, 'Failed to find or create group feed when publishing to a group'))

            publishAndPrune(ssb, content, groupFeed.keys, cb)
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
                    return {
                      id: lodashGet(msg, 'value.content.recps[0]'),
                      secret: Buffer.from(
                        lodashGet(msg, 'value.content.secret'),
                        'base64'
                      ),
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
                key: groupInfo.secret,
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
      publish,
      listMembers,
      listInvites,
      acceptInvite,
      start,
    }
  },
}
