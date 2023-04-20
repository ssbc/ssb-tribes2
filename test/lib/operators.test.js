// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { promisify } = require('util')

const Server = require('../helpers/testbot')
const { groupRecp, tangleRoot } = require('../../lib/operators')

test('lib/operators - groupRecp', async (t) => {
  const alice = Server()
  await alice.tribes2.start()

  const [group, group2] = await Promise.all([
    alice.tribes2.create(),
    alice.tribes2.create(),
  ])

  const content = {
    type: 'post',
    text: 'hey hey',
    recps: [group.id],
  } // NOTE this gets mutates with tangles.group

  await Promise.all([
    alice.tribes2.publish(content),
    alice.tribes2.publish({
      type: 'post',
      text: 'ho ho',
      recps: [group2.id],
    }),
    promisify(alice.db.create)({
      content: {
        type: 'post',
        text: 'he he',
      },
    }),
  ])

  const { where, and, type, toPromise } = alice.db.operators
  const results = await alice.db.query(
    where(and(type('post'), groupRecp(group.id))),
    toPromise()
  )

  t.deepEqual(
    results.map((m) => m.value.content),
    [content],
    'finds the message in the group'
  )

  alice.close()

  t.end()
})

test('lib/operators - tangleRoot', async (t) => {
  const alice = Server()

  const rootId = await promisify(alice.db.create)({
    content: {
      type: 'slime',
      tangles: {
        slime: { root: null, previous: null },
      },
    },
  })

  const updateContent1 = {
    type: 'slime',
    count: 1,
    tangles: {
      slime: { root: rootId, previous: [rootId] },
    },
  }
  const updateContent2 = {
    type: 'slime',
    count: 2,
    tangles: {
      slime: { root: rootId, previous: [rootId] },
    },
  }
  await promisify(alice.db.create)({ content: updateContent1 })
  await promisify(alice.db.create)({ content: updateContent2 })

  const { where, toPromise } = alice.db.operators
  const results = await alice.db.query(
    where(tangleRoot('slime', rootId)),
    toPromise()
  )

  t.deepEqual(
    results.map((m) => m.value.content),
    [updateContent1, updateContent2],
    'finds the message in the tangle'
  )

  alice.close()

  t.end()
})
