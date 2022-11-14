// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const {
  isClassicMessageSSBURI,
  isIdentityGroupSSBURI,
  fromFeedSigil,
} = require('ssb-uri2')
const { promisify: p } = require('util')
const { where, type, toPromise } = require('ssb-db2/operators')
const Testbot = require('./helpers/testbot')

test('create', async (t) => {
  const ssb = Testbot()

  const { id, subfeed, secret, root } = await ssb.tribes2
    .create()
    .catch(t.error)

  t.true(isIdentityGroupSSBURI(id), 'has group id')
  t.true(Buffer.isBuffer(secret), 'has secret')
  t.true(isClassicMessageSSBURI(root), 'has root')
  t.true(ref.isFeed(subfeed.id), 'has subfeed')

  await p(ssb.close)(true)
})

// this is more of an integration test over the api
test('create more', async (t) => {
  const ssb = Testbot()

  const group = await ssb.tribes2.create().catch(t.fail)

  t.true(isIdentityGroupSSBURI(group.id), 'returns group identifier - groupId')
  t.true(
    Buffer.isBuffer(group.secret) && group.secret.length === 32,
    'returns group symmetric key - groupKey'
  )

  const msgVal = await p(ssb.db.get)(group.root).catch(t.fail)

  t.deepEqual(
    msgVal.content,
    {
      type: 'group/init',
      tangles: {
        group: { root: null, previous: null },
      },
    },
    'can decrypt group/init'
  )

  // check I published a group/add-member to myself
  const msgs = await ssb.db.query(where(type('group/add-member')), toPromise())

  t.equals(msgs.length, 1, 'published only one group/add-member message')

  t.deepEqual(
    msgs[0].value.content, // contents of the latest message
    {
      type: 'group/add-member',
      version: 'v1',
      groupKey: group.secret.toString('base64'),
      root: group.root,
      recps: [group.id, fromFeedSigil(ssb.id)], // me being added to the group
      tangles: {
        members: {
          root: group.root,
          previous: [group.root],
        },
        group: {
          root: group.root,
          previous: [group.root],
        },
      },
    },
    'The admin was was also added to the group'
  )

  await p(ssb.close)(true)
})

test('root message is encrypted', async (t) => {
  const alice = Testbot()

  alice.tribes2.start()
  const group = await alice.tribes2.create().catch(t.fail)

  const kvt = await p(alice.db.getMsg)(group.root).catch(t.fail)

  t.true(kvt.meta && kvt.meta.private, 'encrypted init msg')

  await p(alice.close)(true)
})

//TODO
test.skip('tribes.create (opts.addPOBox)', (t) => {
  const server = Testbot()

  // this is more of an integration test over the api
  server.tribes.create({ addPOBox: true }, (err, data) => {
    if (err) throw err

    t.true(isPoBox(data.poBoxId), 'data.poBoxId')

    server.close()
    t.end()
  })
})
