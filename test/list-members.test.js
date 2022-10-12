// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const keys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const pull = require('pull-stream')

test('list members', (t) => {
  const server = Testbot()

  server.tribes2.create(null, (err, group) => {
    t.error(err, 'created group')
    const newFriends = Array(6)
      .fill(0)
      .map(() => keys.generate().id)

    server.tribes2.addMembers(group.id, newFriends, { text: 'ahoy' }, (err) => {
      t.error(err, 'invited friends')

      pull(
        server.tribes2.listMembers(group.id),
        pull.collect((err, authors) => {
          t.error(err, 'returned members')

          t.deepEqual(authors, [server.id, ...newFriends], 'lists members')

          server.close(true, t.end)
        })
      )
    })
  })
})
