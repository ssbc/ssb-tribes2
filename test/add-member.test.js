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

  await Promise.all([alice.tribes2.start(), bob.tribes2.start()])
  t.pass('tribes2 started for both alice and bob')

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicate their trees')

  const {
    id: groupId,
    writeKey,
    root,
  } = await alice.tribes2.create().catch((err) => {
    console.error('alice failed to create group', err)
    t.fail(err)
  })
  t.pass('alice created a group')

  await alice.tribes2.addMembers(groupId, [bobRoot.id]).catch((err) => {
    console.error('add member fail', err)
    t.fail(err)
  })
  t.pass('alice added bob to the group')

  await replicate(alice, bob)
    .then(() =>
      t.pass('alice and bob replicate after bob getting added to the group')
    )
    .catch((err) => {
      console.error(
        'failed to replicate after alice added bob to the group',
        err
      )
      t.error(err)
    })

  await bob.tribes2.acceptInvite(groupId).catch((err) => {
    console.error('failed to accept invite', err)
    t.fail(err)
  })

  t.pass('bob accepted invite')

  await new Promise((res) =>
    pull(
      bob.tribes2.list(),
      pull.collect((err, bobList) => {
        t.equal(bobList.length, 1, 'bob is a member of a group now')
        const group = bobList[0]
        t.equal(group.id, groupId, 'group id is correct')
        t.true(group.writeKey.key.equals(writeKey.key))
        t.equal(group.root, root)
        res()
      })
    )
  )

  await Promise.all([p(alice.close)(true), p(bob.close)(true)])
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
  await Promise.all([kaitiaki.tribes2.start(), newPerson.tribes2.start()])
  t.pass('they start up tribes2')

  const kaitiakiRoot = await p(kaitiaki.metafeeds.findOrCreate)()
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
      groupKey: group.writeKey.key.toString('base64'),
      root: group.root,
      creator: kaitiakiRoot.id,

      text: 'welcome friends',
      recps: [group.id, ...newMembers],

      tangles: {
        group: {
          root: group.root,
          // we don't know the key of the last message, that was the admin adding themselves
          previous: invite.content.tangles.group.previous,
        },
        members: {
          root: group.root,
          previous: invite.content.tangles.group.previous,
        },
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

    await newPerson.tribes2.acceptInvite(group.id)

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

  await Promise.all([p(kaitiaki.close)(true), p(newPerson.close)(true)])
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

test('can or cannot add someone back into a group', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })
  let bob = Testbot({
    name: 'bobrestart',
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })

  await Promise.all([alice.tribes2.start(), bob.tribes2.start()])

  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob).catch(t.error)

  const { id: groupId } = await alice.tribes2
    .create()
    .catch((err) => t.error(err, 'alice failed to create group'))

  await alice.tribes2
    .addMembers(groupId, [bobRoot.id])
    .then(() => t.pass('added bob'))
    .catch((err) => t.error(err, 'add bob fail'))

  await replicate(alice, bob).catch(t.error)

  await bob.tribes2.acceptInvite(groupId)

  await replicate(alice, bob).catch(t.error)

  await alice.tribes2
    .excludeMembers(groupId, [bobRoot.id])
    .then(() => t.pass('alice excluded bob'))
    .catch((err) => t.error(err, 'remove member fail'))

  await replicate(alice, bob).catch(t.error)

  await alice.tribes2
    .addMembers(groupId, [bobRoot.id])
    .then(() => t.pass('added bob back in again'))
    .catch((err) => t.error(err, 'add bob back fail'))

  await replicate(alice, bob).catch(t.error)

  // TODO: test listinvite
  await bob.tribes2.acceptInvite(groupId).catch(t.error)

  async function verifyInGroup(peer) {
    // TODO: test listInvites

    await peer.tribes2
      .acceptInvite(groupId)
      .then(() => t.fail('consumed invite twice'))
      .catch(() => t.pass("can't consume invite twice"))

    const list = await pull(peer.tribes2.list(), pull.collectAsPromise())
    t.equal(list.length, 1, 'one group')
    t.equal(list[0].id, groupId, 'id in list is correct')

    // TODO: test if writeKey is there

    // TODO: test if `excluded` is there
  }

  await verifyInGroup(bob)

  await p(bob.close)(true).then(() => t.pass("bob's client was closed"))
  bob = Testbot({
    rimraf: false,
    name: 'bobrestart',
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })
  t.pass('bob got a new client')
  await bob.tribes2.start().then(() => t.pass('bob restarted'))

  await verifyInGroup(bob)

  await p(alice.close)(true)
  await p(bob.close)(true)
})
