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

  await alice.tribes2.start()
  await bob.tribes2.start()
  await carol.tribes2.start()

  const aliceRoot = await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()

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

  await p(alice.close)(true)
  await p(bob.close)(true)
  await p(carol.close)(true)
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

  await alice.tribes2.start()
  await bob.tribes2.start()

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

  await p(alice.close)(true)
  await p(bob.close)(true)
})
