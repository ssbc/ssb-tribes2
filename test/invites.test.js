// SPDX-FileCopyrightText: 2023 Jacob Karlsson
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const pull = require('pull-stream')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('lists correct group invite and accepting actually does something', async (t) => {
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
      '000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })

  await Promise.all([
    alice.tribes2.start(),
    bob.tribes2.start(),
  ])
  t.pass('tribes2 started')

  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicate their trees')

  const group = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  await alice.tribes2
    .addMembers(group.id, [bobRoot.id])
    .catch((err) => t.fail(err))
  t.pass('alice added bob to the group')

  await replicate(alice, bob).catch(t.fail)
  t.pass('alice and bob replicate')

  const invites = await pull(bob.tribes2.listInvites(), pull.collectAsPromise())
  t.equal(invites.length, 1, 'bob has 1 invite')

  const invite = invites[0]
  t.equal(invite.id, group.id, 'correct group id in invite')
  t.true(invite.writeKey.key.equals(group.writeKey.key), 'correct writeKey')
  t.true(
    invite.readKeys[0].key.equals(group.readKeys[0].key),
    'correct readKey'
  )
  t.equal(invite.root, group.root, 'correct root')

  const msgEnc = await p(bob.db.get)(group.root).catch(t.fail)
  t.equals(
    typeof msgEnc.content,
    'string',
    "bob can't read root msg before he's accepted the invite"
  )

  await bob.tribes2.acceptInvite(invite.id)
  t.pass('bob accepted invite')

  const noInvites = await pull(
    bob.tribes2.listInvites(),
    pull.collectAsPromise()
  )
  t.equal(noInvites.length, 0, 'bob has no invites left')

  const msgUnEnc = await p(bob.db.get)(group.root).catch(t.fail)
  t.true(
    typeof msgUnEnc.content === 'object' && msgUnEnc.content.type,
    'bob can now read root msg after accepting the invite'
  )

  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
  ])
})
