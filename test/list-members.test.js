// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const pull = require('pull-stream')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('list members', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  const bob = Testbot({
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })

  const carol = Testbot({
    keys: ssbKeys.generate(null, 'carol'),
    mfSeed: Buffer.from(
      '00000000000000000000000000000000000000000000000000000000000ca501',
      'hex'
    ),
  })

  await Promise.all([
    alice.tribes2.start(),
    bob.tribes2.start(),
    carol.tribes2.start(),
  ])

  const [aliceRoot, bobRoot, carolRoot] = await Promise.all([
    p(alice.metafeeds.findOrCreate)(),
    p(bob.metafeeds.findOrCreate)(),
    p(carol.metafeeds.findOrCreate)(),
  ])

  await replicate(alice, bob)
  t.pass('alice and bob replicated their trees')
  await replicate(alice, carol)
  t.pass('alice and carol replicated their trees')

  const group = await p(alice.tribes2.create)(null).catch(t.fail)
  t.pass('alice created a group')

  await p(alice.tribes2.addMembers)(group.id, [bobRoot.id, carolRoot.id], {
    text: 'ahoy',
  }).catch((err) => {
    t.fail(err)
  })
  t.pass('alice added bob and carol to the group')

  await new Promise((res) => {
    pull(
      alice.tribes2.listMembers(group.id),
      pull.collect((err, members) => {
        t.error(err, 'returned members')

        t.deepEqual(
          members,
          [aliceRoot.id, bobRoot.id, carolRoot.id],
          'lists members'
        )

        res()
      })
    )
  })

  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
})

test('live list members', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  const bob = Testbot({
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })

  await Promise.all([alice.tribes2.start(), bob.tribes2.start()])

  const aliceRoot = await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicated their trees')

  const group = await p(alice.tribes2.create)(null).catch(t.fail)
  t.pass('alice created a group')

  const members = []
  pull(
    alice.tribes2.listMembers(group.id, { live: true }),
    pull.drain(
      (member) => {
        members.push(member)
      },
      (err) => {
        if (err) t.fail(err)
      }
    )
  )

  await p(setTimeout)(2000)
  t.deepEqual(members, [aliceRoot.id], 'only alice in the group so far')

  await alice.tribes2
    .addMembers(group.id, [bobRoot.id])
    .catch((err) => t.fail(err))

  await p(setTimeout)(2000)
  t.deepEqual(members, [aliceRoot.id, bobRoot.id], 'bob add was detected live')

  await Promise.all([p(alice.close)(true), p(bob.close)(true)])
})

test('listMembers works with exclusion', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })
  const bob = Testbot({
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })
  const carol = Testbot({
    keys: ssbKeys.generate(null, 'carol'),
    mfSeed: Buffer.from(
      '00000000000000000000000000000000000000000000000000000000000ca201',
      'hex'
    ),
  })
  const david = Testbot({
    keys: ssbKeys.generate(null, 'david'),
    mfSeed: Buffer.from(
      '00000000000000000000000000000000000000000000000000000000000da71d',
      'hex'
    ),
  })

  await Promise.all([
    alice.tribes2.start(),
    bob.tribes2.start(),
    carol.tribes2.start(),
    david.tribes2.start(),
  ]).then(() => t.pass('tribes2 started for everyone'))

  const [aliceRoot, bobRoot, carolRoot, davidRoot] = await Promise.all([
    p(alice.metafeeds.findOrCreate)(),
    p(bob.metafeeds.findOrCreate)(),
    p(carol.metafeeds.findOrCreate)(),
    p(david.metafeeds.findOrCreate)(),
  ])

  await Promise.all([
    replicate(alice, bob),
    replicate(alice, carol),
    replicate(alice, david),
  ]).then(() => t.pass('everyone replicates their trees'))

  const { id: groupId } = await alice.tribes2
    .create()
    .catch((err) => t.error(err, 'alice failed to create group'))

  const liveMembers = new Set()
  pull(
    alice.tribes2.listMembers(groupId, { live: true }),
    pull.drain(
      (update) => {
        if (update.excluded) liveMembers.delete(update.excluded)
        else liveMembers.add(update)
      },
      (err) => t.error(err)
    )
  )

  await p(setTimeout)(1000)

  t.deepEquals([...liveMembers], [aliceRoot.id], 'only alice is in the group')

  await alice.tribes2
    .addMembers(groupId, [bobRoot.id, carolRoot.id])
    .catch((err) => t.error(err, 'add bob and carol fail'))

  await p(setTimeout)(500)
  t.deepEquals(
    [...liveMembers].sort(),
    [aliceRoot.id, bobRoot.id, carolRoot.id].sort(),
    'alice bob and carol are in the group'
  )

  await Promise.all([replicate(alice, bob), replicate(alice, carol)])

  await Promise.all([
    bob.tribes2.acceptInvite(groupId),
    carol.tribes2.acceptInvite(groupId),
  ])

  await Promise.all([replicate(alice, bob), replicate(alice, carol)])

  await alice.tribes2
    .excludeMembers(groupId, [bobRoot.id])
    .then((res) => {
      t.pass('alice excluded bob')
      return res
    })
    .catch((err) => t.error(err, 'remove member fail'))

  await Promise.all([replicate(alice, bob), replicate(alice, carol)])

  await p(setTimeout)(500)
  t.deepEquals(
    [...liveMembers].sort(),
    [aliceRoot.id, carolRoot.id].sort(),
    'bob is out of the group'
  )

  await alice.tribes2
    .addMembers(groupId, [davidRoot.id])
    .catch((err) => t.error(err, 'add david fail'))

  await Promise.all([replicate(alice, bob), replicate(alice, carol)])

  const aliceMembers = await pull(
    alice.tribes2.listMembers(groupId),
    pull.collectAsPromise()
  )
  t.deepEquals(
    aliceMembers.sort(),
    [aliceRoot.id, carolRoot.id, davidRoot.id].sort(),
    'alice gets the correct members list'
  )

  const carolMembers = await pull(
    carol.tribes2.listMembers(groupId),
    pull.collectAsPromise()
  )
  t.deepEquals(
    carolMembers.sort(),
    [aliceRoot.id, carolRoot.id, davidRoot.id].sort(),
    'carol gets the correct members list'
  )

  await pull(bob.tribes2.listMembers(groupId), pull.collectAsPromise())
    .then(() =>
      t.fail(
        "Bob didn't get an error when trying to list members of the group he's excluded from"
      )
    )
    .catch(() =>
      t.pass(
        "Bob gets an error when trying to list members of the group he's excluded from"
      )
    )

  await p(setTimeout)(500)
  t.deepEquals(
    [...liveMembers].sort(),
    [aliceRoot.id, carolRoot.id, davidRoot.id].sort(),
    'adding david to new epoch got detected live'
  )

  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
    p(david.close)(true),
  ])
})
