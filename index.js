// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify } = require('util')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const pullAsync = require('pull-async')
const lodashGet = require('lodash.get')
const {
  where,
  and,
  isDecrypted,
  type,
  live,
  toPullStream,
} = require('ssb-db2/operators')
const {
  keySchemes,
  validator: {
    group: { init: initSpec, addMember: addMemberSpec },
  },
} = require('private-group-spec')
const { SecretKey } = require('ssb-private-group-keys')
const buildGroupId = require('./lib/build-group-id')
const AddGroupTangle = require('./lib/add-group-tangle')
const prunePublish = require('./lib/prune-publish')

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

    function findOrCreateGroupFeed(input, cb) {
      const groupKey = Buffer.isBuffer(input) ? new SecretKey(input) : input

      const recps = [
        { key: groupKey.toBuffer(), scheme: keySchemes.private_group },
      ]

      const groupFeedDetails = {
        purpose: groupKey.toString(),
        feedFormat: 'classic',
        recps,
        encryptionFormat: 'box2',
      }

      ssb.metafeeds.findOrCreate(groupFeedDetails, (err, groupFeed) => {
        if (err) return cb(err)
        ssb.box2.addKeypair(groupFeed.keys)
        cb(null, groupFeed)
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

      const groupKey = new SecretKey()

      findOrCreateGroupFeed(groupKey, (err, groupFeed) => {
        if (err) return cb(err)

        const recps = [
          { key: groupKey.toBuffer(), scheme: keySchemes.private_group },
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
              id: buildGroupId({ groupInitMsg, groupKey: groupKey.toBuffer() }),
              secret: groupKey.toBuffer(),
              root: groupInitMsg.key,
              subfeed: groupFeed.keys,
            }

            ssb.box2.addGroupInfo(data.id, {
              key: data.secret,
              root: data.root,
            })

            // Adding myself for recovery reasons
            addMembers(data.id, [ssb.id], {}, (err) => {
              if (err) return cb(err)

              return cb(null, data)
            })
          }
        )
      })

      // TODO: consider what happens if the app crashes between any step
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
      if (feedIds.length > 16)
        return cb(new Error(`${feedIds.length} is more than 16 recipients`))

      // TODO
      // copy a lot from ssb-tribes but don't use the keystore from there
      get(groupId, (err, { secret, root }) => {
        if (err) return cb(err)

        const recps = [groupId, ...feedIds]

        const content = {
          type: 'group/add-member',
          version: 'v1',
          groupKey: secret.toString('base64'),
          root,
          tangles: {
            members: {
              root,
              previous: [root], // TODO calculate previous for members tangle
            },
            // likely incorrect group tangle and this will be overwritten by publish()
            // we just add it here to make the spec pass
            group: {
              root,
              previous: [root],
            },
          },
          recps,
        }

        if (opts.text) content.text = opts.text

        if (!addMemberSpec(content))
          return cb(new Error(addMemberSpec.errorsString))

        const invitations = {
          purpose: 'invitations',
          feedFormat: 'classic',
        }

        ssb.metafeeds.findOrCreate(invitations, (err, invitationsFeed) => {
          if (err) return cb(err)
          ssb.box2.addKeypair(invitationsFeed.keys)

          addGroupTangle(content, (err, content) => {
            if (err) return cb(err)

            prunePublish(ssb, content, invitationsFeed.keys, cb)
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

            prunePublish(ssb, content, groupFeed.keys, cb)
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

    // Listeners for joining groups
    function start() {
      pull(
        ssb.db.query(
          where(and(isDecrypted('box2'), type('group/add-member'))),
          live({ old: true }),
          toPullStream()
        ),
        pull.filter((msg) =>
          lodashGet(msg, 'value.content.recps', []).includes(ssb.id)
        ),
        pull.asyncMap((msg, cb) => {
          const groupId = lodashGet(msg, 'value.content.recps[0]')

          ssb.box2.getGroupKeyInfo(groupId, (err, info) => {
            if (err) {
              console.error('Error when finding group invite for me:', err)
              return
            }

            if (!info) {
              // We're not yet in the group
              ssb.box2.addGroupInfo(groupId, {
                key: lodashGet(msg, 'value.content.groupKey'),
                root: lodashGet(msg, 'value.content.root'),
              })
              ssb.db.reindexEncrypted(cb)
            } else {
              cb()
            }
          })
        }),
        pull.drain(() => {})
      )
    }

    return {
      create,
      get,
      list,
      addMembers,
      publish,
      listMembers,
      start,
    }
  },
}
