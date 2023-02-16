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
const { fromMessageSigil, isBendyButtV1FeedSSBURI } = require('ssb-uri2')

const AddGroupTangle = require('./lib/add-group-tangle')
const MetaFeedHelpers = require('./lib/meta-feed-helpers')
const buildGroupId = require('./lib/build-group-id')
const publishAndPrune = require('./lib/prune-publish')
const drainOne = require('./lib/drain-one')

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
      secretKeyFromPurpose,

      findOrCreateAdditionsFeed,
      findOrCreateGroupFeed,
      findOrCreateGroupWithoutMembers,
    } = MetaFeedHelpers(ssb)

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

        const content = {
          type: 'group/add-member',
          version: 'v2',
          secret: secret.toString('base64'),
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
        drainOne(
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
