// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')
const {
  where,
  and,
  isDecrypted,
  type,
  live,
  toPullStream,
} = require('ssb-db2/operators')

module.exports = {
  name: 'tribes2',
  manifest: {
    create: 'async',
    list: 'source',
    invite: 'async',
    start: 'async',
  },
  init(ssb, config) {
    function create(cb) {
      // TODO: use ssb-private-group-keys to create the group keys
      // TODO: use ssb-meta-feeds findOrCreate to create a group feed
      // TODO: use ssb-box2 APIs to register the new group
      // TODO: publish a new group/init message on the group feed
      // TODO: consider what happens if the app crashes between any step
    }

    function list() {
      // TODO: PR on ssb-box2 to have an API to list all group keys
      // TODO: traverse all group keys, "hydrate" each one with details (name,
      // description, etc) about the group
      // TODO: return a pull-stream source
    }

    function invite(feedId, groupId, cb) {
      // TODO
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
      invite,
      start,
    }
  },
}
