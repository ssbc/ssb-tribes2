// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { promisify } = require('util')

const Server = require('../helpers/testbot')
const { isGroup } = require('../../lib/operators')

test('lib/operators - isGroup', async t => {
  const alice = Server()
  await alice.tribes2.start()

  const [group, group2] = await Promise.all([
    alice.tribes2.create(),
    alice.tribes2.create()
  ])

  const content = {
    type: 'post',
    text: 'hey hey',
    recps: [group.id]
  } // NOTE this gets mutates with tangles.group

  await Promise.all([
    alice.tribes2.publish(content),
    alice.tribes2.publish({
      type: 'post',
      text: 'ho ho',
      recps: [group2.id]
    }),
    promisify(alice.db.create)({
      content: {
        type: 'post',
        text: 'he he'
      }
    })
  ])

  const { where, and, type, toPromise } = alice.db.operators
  const results = await alice.db.query(
    where(
      and(
        type('post'),
        isGroup(group.id)
      )
    ),
    toPromise()
  )

  t.deepEqual(
    results.map(m => m.value.content),
    [content],
    'finds the message in the group'
  )

  alice.close()

  t.end()
})
