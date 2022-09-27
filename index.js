// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify } = require('util')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const pullAsync = require('pull-async')
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

module.exports = {
  name: 'tribes2',
  manifest: {
    create: 'async',
    list: 'source',
    addMembers: 'async',
    start: 'async',
  },
  init(ssb, config) {
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

          // TODO: add root on new version of box2
          ssb.box2.addGroupKey(data.id, data.secret)

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
          //TODO: add root
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

      // TODO
      // copy a lot from ssb-tribes but don't use the keystore from there
      const { key, root } = get(groupId)

      const content = {
        type: 'group/add-member',
        version: 'v1',
        groupKey: key.toString('base64'),
        root,
        tangles: {
          members: {
            root,
            previous: [root], // TODO calculate previous for members tangle
          },

          //TODO: this is weird remove it?
          group: { root, previous: [root] },
          // NOTE: this is a dummy entry which is over-written in publish hook
        },
        recps: [groupId, ...feedIds],
      }

      if (opts.text) content.text = opts.text

      if (!addMemberSpec.isValid(content))
        return cb(new Error(addMemberSpec.isValid.errorsString))

      ssb.publish(content, (err) => {
        if (err) return cb(err)

        keystore.group.registerAuthors(groupId, feedIds, (err) => {
          if (err) return cb(err)
          cb()
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
        })
      )
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
