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
const initSpec = require('./spec/init')
const addMemberSpec = require('./spec/add-member')

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
      if (!initSpec.isValid(content))
        return cb(new Error(initSpec.isValid.errorsString))

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

          // adding myself for recovery reasons
          addMembers(data.id, [ssb.id], {}, (err) => {
            if (err) return cb(err)

            return cb(null, data)
          })
        }
      )
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
          },
          recps,
        }

        if (opts.text) content.text = opts.text

        if (!addMemberSpec.isValid(content))
          return cb(new Error(addMemberSpec.isValid.errorsString))

        publish(content, (err, msg) => {
          if (err) return cb(err)

          //TODO: this is an optimization, use the db query instead for now
          //keystore.group.registerAuthors(groupId, feedIds, (err) => {
          //  if (err) return cb(err)
          return cb(null, msg)
          //})
        })
      })
    }

    function publish(content, cb) {
      if (cb === undefined) return promisify(publish)(content)

      if (!content) return cb(new Error('Missing content'))

      const recps = content.recps
      if (!recps || !Array.isArray(recps) || recps.length < 1)
        return cb(new Error('Missing recps'))

      addGroupTangle(content, (err, content) => {
        if (err) return cb(err)

        ssb.db.create({ content, encryptionFormat: 'box2' }, (err, msg) => {
          if (err) return cb(err)

          cb(null, msg)
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
        pull.asyncMap((msg, cb) => {
          // TODO: call ssb-db2 reindexEncrypted

          if (lodashGet(msg, 'value.content.recps', []).includes(ssb.id)) {
            const groupRoot = lodashGet(msg, 'value.content.root')
            const groupKey = lodashGet(msg, 'value.content.groupKey')
            const groupId = lodashGet(msg, 'value.content.recps[0]')

            ssb.box2.getGroupKeyInfo(groupId, (err, info) => {
              if (err) {
                return console.error(
                  'Error when finding group invite for me:',
                  err
                )
              }

              if (!info) {
                // we're not already in the group
                ssb.box2.addGroupInfo(groupId, {
                  key: groupKey,
                  root: groupRoot,
                })
              }
              return cb()
            })
          } else {
            return cb()
          }
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
