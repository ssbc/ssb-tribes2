// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const { promisify } = require('util')
const pull = require('pull-stream')
const {
  where,
  and,
  isDecrypted,
  type,
  live,
  toPullStream,
} = require('ssb-db2/operators')
const { box } = require('envelope-js')
const { keySchemes } = require('private-group-spec')
const { SecretKey } = require('ssb-private-group-keys')
const bfe = require('ssb-bfe')
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

      // TODO: use ssb-private-group-keys to create the group keys
      // TODO: use ssb-meta-feeds findOrCreate to create a group feed
      // TODO: use ssb-box2 APIs to register the new group
      // TODO: publish a new group/init message on the group feed
      // TODO: consider what happens if the app crashes between any step

      const groupKey = new SecretKey()
      const content = {
        type: 'group/init',
        tangles: {
          group: { root: null, previous: null },
        },
      }
      //if (!initSpec.isValid(content)) return cb(new Error(initSpec.isValid.errorsString))

      /* enveloping */
      // we have to do it manually this one time, because the auto-boxing checks for a known groupId
      // but the groupId is derived from the messageId of this message (which does not exist yet
      const plain = Buffer.from(JSON.stringify(content), 'utf8')

      const msgKey = new SecretKey().toBuffer()
      const recipientKeys = [
        { key: groupKey.toBuffer(), scheme: keySchemes.private_group },
      ]

      ssb.getFeedState(ssb.id, (err, previousFeedState) => {
        if (err) return cb(err)

        const feedId = bfe.encode(ssb.id)

        const previousMessageId = bfe.encode(previousFeedState.id)

        const envelope = box(
          plain,
          feedId,
          previousMessageId,
          msgKey,
          recipientKeys
        )
        const ciphertext = envelope.toString('base64') + '.box2'

        ssb.db.create(
          {
            content: ciphertext,
            // TODO
            //keys: subfeed.keys
          },
          (err, groupInitMsg) => {
            if (err) return cb(err)

            const data = {
              id: buildGroupId({ groupInitMsg, msgKey }),
              secret: groupKey.toBuffer(),
              root: groupInitMsg.key,
              subfeed: '',
            }

            ssb.box2.addGroupKey(data.id, data.secret)

            // TODO later: add myself for recovery reasons

            cb(null, data)
          }
        )
      })
    }

    function list() {
      // TODO: PR on ssb-box2 to have an API to list all group keys
      // TODO: traverse all group keys, "hydrate" each one with details (name,
      // description, etc) about the group
      // TODO: return a pull-stream source
    }

    function addMembers(groupId, feedIds, cb) {
      // TODO
      // copy a lot from ssb-tribes but don't use the keystore from there
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
      list,
      addMembers,
      start,
    }
  },
}
