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
const { keySchemes } = require('private-group-spec')
const { SecretKey } = require('ssb-private-group-keys')
//const Crut = require('ssb-crut')
const buildGroupId = require('./lib/build-group-id')
const AddGroupTangle = require('./lib/add-group-tangle')

module.exports = {
  name: 'tribes2',
  manifest: {
    create: 'async',
    list: 'source',
    addMembers: 'async',
    start: 'async',
  },
  init(ssb, config) {
    const addGroupTangle = AddGroupTangle(ssb)

    function create(opts = {}, cb) {
      if (cb === undefined) return promisify(create)(opts)

      // TODO: use ssb-meta-feeds findOrCreate to create a group feed
      // TODO: publish the message on the group feed
      // TODO: consider what happens if the app crashes between any step

      const groupKey = new SecretKey()
      const content = {
        type: 'group/init',
        tangles: {
          group: { root: null, previous: null },
        },
      }
      //if (!initSpec.isValid(content)) return cb(new Error(initSpec.isValid.errorsString))

      const recipientKeys = [
        { key: groupKey.toBuffer(), scheme: keySchemes.private_group },
      ]

      ssb.db.create(
        {
          content,
          recps: recipientKeys,
          encryptionFormat: 'box2',
        },
        (err, groupInitMsg) => {
          if (err) return cb(err)

          const data = {
            id: buildGroupId({ groupInitMsg, groupKey: groupKey.toBuffer() }),
            secret: groupKey.toBuffer(),
            root: groupInitMsg.key,
            subfeed: '',
          }

          ssb.box2.addGroupInfo(data.id, { key: data.secret, root: data.root })

          // TODO later: add myself for recovery reasons

          cb(null, data)
        }
      )
    }

    function get(id, cb) {
      if (cb === undefined) return promisify(get)(id)

      ssb.box2.getGroupKeyInfo(id, (err, info) => {
        if (err) cb(err)

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
          },
          recps,
        }

        if (opts.text) content.text = opts.text

        addGroupTangle(content, (err, content) => {
          if (err) return cb(err)

          //if (!addMemberSpec.isValid(content))
          //  return cb(new Error(addMemberSpec.isValid.errorsString))

          ssb.db.create({ content, recps, encryptionFormat: 'box2' }, (err) => {
            if (err) return cb(err)

            //TODO: this is an optimization, use the db query instead for now
            //keystore.group.registerAuthors(groupId, feedIds, (err) => {
            //  if (err) return cb(err)
            cb()
            //})
          })
        })
      })
    }

    // Listeners for joining groups
    function start() {
      pull(
        ssb.db.query(
          where(and(isDecrypted('box2'), type('group/add-member'))),
          live({ old: true }),
          toPullStream()
        ),
        pull.drain((msg) => {
          // TODO: check if we already have this msg' group key in ssb-box2
          // TODO: if we do, ignore this msg
          // TODO: else, register the group key in ssb-box2
          // TODO: call ssb-db2 reindexEncrypted

          if (lodashGet(msg, 'value.content.recps', []).includes(ssb.id)) {
            const groupRoot = lodashGet(msg, 'value.content.root')
            const groupKey = lodashGet(msg, 'value.content.groupKey')
            const groupId = lodashGet(msg, 'value.content.recps[0]')

            ssb.box2.addGroupInfo(groupId, { key: groupKey, root: groupRoot })
          }
        })
      )

      //pull(
      //  ssb.db.query(live({ old: true }), toPullStream()),
      //  pull.drain((msg) => {
      //    console.log('i got any kind of message', {
      //      author: msg.value.author,
      //      seq: msg.value.sequence,
      //      myId: ssb.id,
      //    })
      //  })
      //)
    }

    return {
      create,
      get,
      list,
      addMembers,
      start,
    }
  },
}
