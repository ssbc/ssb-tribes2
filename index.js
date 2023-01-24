// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify } = require('util')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const pullAsync = require('pull-async')
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
              if (err) return cb(err)

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
            if (err) cb(err)
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
        if (err) return cb(err)
        cb(null, groupFeed)
      })
    }

    function findOrCreateGroupFeed(input = null, cb) {
      const inputSecret = Buffer.isBuffer(input) ? new SecretKey(input) : input

      ssb.metafeeds.findOrCreate(function gotRoot(err, root) {
        if (err) return cb(err)

        // 1. publish. we know the secret and should just findOrCreate the feed
        // 2. create. we don't have a secret yet but can make or find one
        //   2.1. try to find an empty feed in case we've crashed before. use the secret from that one
        //   2.2. if we can't find an empty feed, make a new secret and findOrCreate

        if (inputSecret) {
          return findOrCreateFromSecret(inputSecret, root.id, cb)
        } else {
          findEmptyGroupFeed(root.id, (err, emptyFeed) => {
            if (err) return cb(err)

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

    function create(opts = {}, cb) {
      if (cb === undefined) return promisify(create)(opts)

      const content = {
        type: 'group/init',
        tangles: {
          group: { root: null, previous: null },
        },
      }
      if (!initSpec(content)) return cb(new Error(initSpec.errorsString))

      ssb.metafeeds.findOrCreate(function gotRoot(err, root) {
        if (err) return cb(err)

        findOrCreateGroupFeed(null, function gotGroupFeed(err, groupFeed) {
          if (err) return cb(err)

          const secret = new SecretKey(Buffer.from(groupFeed.purpose, 'base64'))

          const recps = [
            { key: secret.toBuffer(), scheme: keySchemes.private_group },
          ]

          ssb.db.create(
            {
              keys: groupFeed.keys,
              content,
              recps,
              encryptionFormat: 'box2',
            },
            (err, groupInitMsg) => {
              if (err) return cb(err)

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
              addMembers(data.id, [root.id], {}, (err) => {
                if (err) return cb(err)

                return cb(null, data)
              })
            }
          )
        })
      })
    }

    function get(id, cb) {
      if (cb === undefined) return promisify(get)(id)

      ssb.box2.getGroupKeyInfo(id, (err, info) => {
        if (err) return cb(err)

        if (!info) return cb(new Error(`Couldn't find group with id ${id}`))

        cb(null, {
          id,
          secret: info.key,
          root: info.root,
        })
      })
    }

    function list() {
      return pull(
        pullAsync((cb) => ssb.box2.listGroupIds(cb)),
        pull.map((ids) => pull.values(ids)),
        pull.flatten(),
        paraMap(get, 4)
      )
    }

    function addMembers(groupId, feedIds, opts = {}, cb) {
      if (cb === undefined) return promisify(addMembers)(groupId, feedIds, opts)

      if (!feedIds || feedIds.length === 0)
        return cb(new Error('No feedIds provided to addMembers'))
      if (feedIds.length > 15)
        return cb(
          new Error(`Tried to add ${feedIds.length} members, the max is 15`)
        )
      if (feedIds.some((id) => !isBendyButtV1FeedSSBURI(id)))
        return cb(new Error('addMembers only supports bendybutt-v1 feed IDs'))

      get(groupId, (err, { secret, root }) => {
        if (err) return cb(err)

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
          if (err) return cb(err)

          addGroupTangle(content, (err, content) => {
            if (err) return cb(err)

            publishAndPrune(ssb, content, additionsFeed.keys, cb)
          })
        })
      })
    }

    function publish(content, cb) {
      if (cb === undefined) return promisify(publish)(content)

      if (!content) return cb(new Error('Missing content'))

      const recps = content.recps
      if (!recps || !Array.isArray(recps) || recps.length < 1)
        return cb(new Error('Missing recps'))
      const groupId = recps[0]

      addGroupTangle(content, (err, content) => {
        if (err) return cb(err)

        get(groupId, (err, { secret }) => {
          if (err) return cb(err)

          findOrCreateGroupFeed(secret, (err, groupFeed) => {
            if (err) return cb(err)

            publishAndPrune(ssb, content, groupFeed.keys, cb)
          })
        })
      })
    }

    function listMembers(groupId) {
      return pull(
        ssb.db.query(
          where(and(isDecrypted('box2'), type('group/add-member'))),
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
            if (err)
              return cb(
                clarify(err, 'Failed to get root metafeed when listing invites')
              )

            ssb.box2.listGroupIds((err, groupIds) => {
              if (err)
                return cb(
                  clarify(err, 'Failed to list group IDs when listing invites')
                )

              const source = pull(
                ssb.db.query(
                  where(and(isDecrypted('box2'), type('group/add-member'))),
                  toPullStream()
                ),
                pull.filter((msg) =>
                  // it's an addition of us
                  lodashGet(msg, 'value.content.recps', []).includes(myRoot.id)
                ),
                pull.filter(
                  (msg) =>
                    // we haven't already accepted the addition
                    !groupIds.includes(lodashGet(msg, 'value.content.recps[0]'))
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
            ssb.box2.addGroupInfo(groupInfo.id, {
              key: groupInfo.secret,
              root: groupInfo.root,
            })

            ssb.db.reindexEncrypted(cb)
          },
          (err) => {
            if (err) return cb(err)
            if (!foundInvite)
              return cb(new Error("Didn't find invite for that group id"))
          }
        )
      )
    }

    function start(cb) {
      if (cb === undefined) return promisify(start)()

      findOrCreateAdditionsFeed((err) => {
        if (err)
          return cb(clarify(err, 'Error finding or creating additions feed'))
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
