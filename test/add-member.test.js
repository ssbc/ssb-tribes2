// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const pull = require('pull-stream')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('get added to a group', async (t) => {
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

  alice.tribes2.start()
  bob.tribes2.start()
  t.pass('tribes2 started for both alice and bob')

  const aliceRoot = await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicate their trees')

  const {
    id: groupId,
    subfeed,
    secret,
    root,
  } = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  await alice.tribes2.addMembers(groupId, [bobRoot.id])
  t.pass('alice added bob to the group')

  await replicate(alice, bob, { waitUntilMembersOf: groupId })
  t.pass('alice and bob replicate')

  await new Promise((res) =>
    pull(
      bob.tribes2.list(),
      pull.collect((err, bobList) => {
        t.equal(bobList.length, 1, 'bob is a member of a group now')
        const group = bobList[0]
        t.equal(group.id, groupId)
        t.true(group.secret.equals(secret))
        t.equal(group.root, root)
        res()
      })
    )
  )

  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('add member', async (t) => {
  const kaitiaki = Testbot({
    keys: ssbKeys.generate(null, 'kaitiaki'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a11a',
      'hex'
    ),
  })
  const newPerson = Testbot({
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })
  kaitiaki.tribes2.start()
  newPerson.tribes2.start()
  t.pass('they start up tribes2')

  const newPersonRoot = await p(newPerson.metafeeds.findOrCreate)()

  await replicate(kaitiaki, newPerson)
  t.pass('they replicate their trees')

  try {
    const group = await kaitiaki.tribes2.create()
    t.true(group.id, 'creates group')

    const newMembers = [newPersonRoot.id]

    const encryptedInvite = await kaitiaki.tribes2.addMembers(
      group.id,
      newMembers,
      {
        text: 'welcome friends',
      }
    )

    const invite = await p(kaitiaki.db.get)(encryptedInvite.key)

    const expected = {
      type: 'group/add-member',
      version: 'v2',
      secret: group.secret.toString('base64'),
      root: group.root,

      text: 'welcome friends',
      recps: [group.id, ...newMembers],

      tangles: {
        group: {
          root: group.root,
          // we don't know the key of the last message, that was the admin adding themselves
          previous: invite.content.tangles.group.previous,
        },
        members: { root: group.root, previous: [group.root] },
      },
    }
    t.deepEqual(invite.content, expected, 'kaitiaki sent invite')

    /* kaitiaki posts to group, new person can read */
    const greetingContent = {
      type: 'post',
      text: 'Welcome new person!',
      recps: [group.id],
    }
    const { key: greetingKey } = await kaitiaki.tribes2.publish(greetingContent)
    await replicate(kaitiaki, newPerson)
    const greetingMsg = await p(newPerson.db.getMsg)(greetingKey)
    t.deepEqual(
      greetingMsg.value.content,
      greetingContent,
      'new person can read group content'
    )

    /* new person posts to group, kaitiaki can read */
    const replyContent = {
      type: 'post',
      text: 'Thank you kaitiaki',
      recps: [group.id],
    }
    const { key: replyKey } = await newPerson.tribes2.publish(replyContent)
    await replicate(newPerson, kaitiaki)
    const replyMsg = await p(kaitiaki.db.getMsg)(replyKey)
    t.deepEqual(
      replyMsg.value.content,
      replyContent,
      'kaitiaki can read things from new person'
    )
  } catch (err) {
    t.fail(err)
  }

  await p(kaitiaki.close)(true)
  await p(newPerson.close)(true)
})

test('addMembers empty', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  alice.tribes2.start()
  t.pass('tribes2 started')

  const group = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  try {
    await alice.tribes2.addMembers(group.id, [])
    t.fail('addMembers should throw')
  } catch (err) {
    t.equal(err.message, 'No feedIds provided to addMembers')
  }

  await p(alice.close)(true)
})

test('addMembers wrong feed format for feed IDs', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  alice.tribes2.start()
  t.pass('tribes2 started')

  const group = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  const classicId = ssbKeys.generate(null, 'carol').id

  try {
    await alice.tribes2.addMembers(group.id, [classicId])
    t.fail('addMembers should throw')
  } catch (err) {
    t.equal(err.message, 'addMembers only supports bendybutt-v1 feed IDs')
  }

  await p(alice.close)(true)
})

test('addMembers too many members', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  alice.tribes2.start()
  t.pass('tribes2 started')

  const group = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  const TOTAL = 20

  const feedIds = Array.from(
    { length: TOTAL },
    (_, i) => ssbKeys.generate(null, `bob${i}`).id
  )

  try {
    await alice.tribes2.addMembers(group.id, feedIds)
    t.fail('addMembers should throw')
  } catch (err) {
    t.equal(err.message, 'Tried to add ' + TOTAL + ' members, the max is 15')
  }

  await p(alice.close)(true)
})

// for replicating a group you're not in yet
async function replicateGroup(p1, p2, group) {
  const groupSecret = group.secret.toString('base64')
  console.log('groupSecret', groupSecret)

  p1.ebt.request(groupSecret, true)
  p2.ebt.request(groupSecret, true)

  const conn = await p(p1.connect)(p2.getAddress())
  await p(setTimeout)(10000)
  await p(conn.close)(true)
}

test.only('can read older messages from before being added to group', async (t) => {
  const alice = Testbot({
    //keys: ssbKeys.generate(null, 'kaitiaki'),
    //mfSeed: Buffer.from(
    //  '000000000000000000000000000000000000000000000000000000000000a11a',
    //  'hex'
    //),
  })
  const bob = Testbot({
    //keys: ssbKeys.generate(null, 'bob'),
    //mfSeed: Buffer.from(
    //  '0000000000000000000000000000000000000000000000000000000000000b0b',
    //  'hex'
    //),
  })
  alice.tribes2.start()
  bob.tribes2.start()
  t.pass('they start up tribes2')

  const group = await alice.tribes2.create()
  t.true(group.id, 'alice creates group')

  const earlyMsg = await alice.tribes2.publish({
    type: 'post',
    text: 'i just created a group with only me in it',
    recps: [group.id],
  })
  t.pass('alice publishes encrypted msg')

  //await replicateGroup(alice, bob, group)
  await replicate(alice, bob).catch(t.fail)
  t.pass('they replicate the so far encrypted msg')

  const encryptedMsg = await p(bob.db.getMsg)(earlyMsg.key).catch(t.fail)

  t.true(
    encryptedMsg.meta && encryptedMsg.meta.private,
    "bob can't decrypt group message before he's in it"
  )

  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await alice.tribes2.addMembers(group.id, [bobRoot.id])
  t.pass('alice adds bob to the group')

  await replicate(alice, bob, { waitUntilMembersOf: group.id })
  t.pass("they replicate bob's invite")

  const unencryptedMsg = await p(bob.db.getMsg)(earlyMsg.key)

  t.false(
    unencryptedMsg.meta && unencryptedMsg.meta.private,
    "bob can decrypt the old group message once he's in the group"
  )

  await p(alice.close)(true)
  await p(bob.close)(true)
})
