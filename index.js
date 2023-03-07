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
    group: { content: contentSpec },
  },
} = require('private-group-spec')
const { fromMessageSigil, isBendyButtV1FeedSSBURI } = require('ssb-uri2')
const { SecretKey } = require('ssb-private-group-keys')
const buildGroupId = require('./lib/build-group-id')
const AddGroupTangle = require('./lib/add-group-tangle')
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
    const addGroupTangle = AddGroupTangle(ssb)
    const {
      secretKeyFromString,
      findOrCreateAdditionsFeed,
      findOrCreateGroupFeed,
      findOrCreateEpochWithoutMembers,
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
          writeKey: secret.toBuffer(),
          readKeys: [secret.toBuffer()],
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
      })
    }

    function get(id, cb) {
      if (cb === undefined) return promisify(get)(id)

      ssb.box2.getGroupInfo(id, (err, info) => {
        if (err) return cb(clarify(err, 'Failed to get group details'))

        if (!info) return cb(new Error(`Couldn't find group with id ${id}`))

        cb(null, {
          id,
          writeKey: info.writeKey,
          readKeys: info.readKeys,
          root: info.root,
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

        const content = {
          type: 'group/add-member',
          version: 'v2',
          secret: writeKey.toString('base64'),
          root,
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

        // TODO: this should accept bendybutt-v1 feed IDs
        // if (!addMemberSpec(content))
        //   return cb(new Error(addMemberSpec.errorsString))

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
    }

    function excludeMembers(groupId, feedIds, opts = {}, cb) {
      if (cb === undefined)
        return promisify(excludeMembers)(groupId, feedIds, opts)

      // TODO: should probably check this against a spec of its own
      // TODO: should add members tangle to this. should we add opts to publish()? { spec, tangles, keys}
      publish(
        {
          type: 'group/exclude',
          excludes: feedIds,
          recps: [groupId],
        },
        (err, exclusionMsg) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to publish exclude msg'))

          pull(
            listMembers(groupId),
            pull.collect((err, beforeMembers) => {
              const remainingMembers = beforeMembers.filter(
                (member) => !feedIds.includes(member)
              )

              findOrCreateEpochWithoutMembers((err, group) => {
                // prettier-ignore
                if (err) return cb(clarify(err, 'Failed to create group init message when creating a group'))

                const { groupInitMsg, groupFeed, myRoot } = group

                const newGroupKey = secretKeyFromString(groupFeed.purpose)

                const data = {
                  id: buildGroupId({
                    groupInitMsg,
                    groupKey: newGroupKey.toBuffer(),
                  }),
                  root: fromMessageSigil(groupInitMsg.key),
                  subfeed: groupFeed.keys,
                }

                // TODO: shouldn't be add, should be update or something
                ssb.box2.addGroupInfo(data.id, {
                  key: newGroupKey,
                  root: data.root,
                })

                // TODO: add this key to ourselves. step 1. make sure we ourselves can post to the new feed. step 2 and later: other people can post on the new key
                const newKeyContent = {
                  type: 'group/move-epoch',
                  secret: newGroupKey.toString('base64'),
                  exclusion: fromMessageSigil(exclusionMsg.key),
                  // TODO: how to have the group id in the recps but encrypt to the new key. do we need to put the new key in box2 before this?
                  // maybe we should create the new feed first :thinking: then we'll have the key safely saved there
                  recps: [groupId, ...remainingMembers],
                }
                // TODO: loop if many members
                publish(newKeyContent, (err) => {
                  // prettier-ignore
                  if (err) return cb(clarify(err, 'Failed to tell people about new epoch'))

                  console.log('added people to new epoch')

                  // TODO: create feed for the new epoch
                  // either createGroupWithoutMembers(myRoot, cb) { but with an arg for the secret
                  // or findOrCreateGroupFeed(null, function gotGroupFeed(err, groupFeed) { but we need to duplicate more code (maybe premature to worry about tho)
                })
              })
            })
          )
        }
      )
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

        if (!contentSpec(content))
          return cb(new Error(contentSpec.errorsString))

        get(groupId, (err, { writeKey }) => {
          // prettier-ignore
          if (err) return cb(clarify(err, 'Failed to get group details when publishing to a group'))

          findOrCreateGroupFeed(writeKey, (err, groupFeed) => {
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
      excludeMembers,
      publish,
      listMembers,
      listInvites,
      acceptInvite,
      start,
    }
  },
}
