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

    const [encryptedInvite] = await kaitiaki.tribes2.addMembers(
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
      secret: group.writeKey.key.toString('base64'),
      oldSecrets: [],
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

test('addMembers adds to all the tip epochs and gives keys to all the old epochs as well', async (t) => {
  // alice adds bob and carol
  // alice and bob remove carol at the same time, creating forked epochs
  // everyone still replicates and sees the fork
  // alice adds david to the group, and he should see both forks and the original epoch
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
  ])
    .then(() => t.pass('clients started'))
    .catch((err) => t.error(err))

  const [, bobRootId, carolRootId, davidRootId] = (
    await Promise.all(
      [alice, bob, carol, david].map((peer) => p(peer.metafeeds.findOrCreate)())
    )
      .then((res) => {
        t.pass('got peer roots')
        return res
      })
      .catch((err) => t.error(err))
  ).map((root) => root.id)

  await Promise.all([
    replicate(alice, bob),
    replicate(alice, carol),
    replicate(alice, david),
  ])
    .then(() => t.pass('replicated'))
    .catch((err) => t.error(err))

  const { id: groupId, writeKey: firstEpochKey } = await alice.tribes2
    .create()
    .then((res) => {
      t.pass('alice created group')
      return res
    })
    .catch((err) => t.error(err))
  const firstEpochSecret = firstEpochKey.key.toString('base64')

  const { key: firstEpochPostId } = await alice.tribes2
    .publish({
      type: 'test',
      text: 'first post',
      recps: [groupId],
    })
    .then((res) => {
      t.pass('alice published in first epoch')
      return res
    })
    .catch((err) => t.error(err))

  await alice.tribes2
    .addMembers(groupId, [bobRootId, carolRootId])
    .then(() => t.pass('alice added bob and carol'))
    .catch((err) => t.error(err))

  await Promise.all([
    replicate(alice, bob),
    replicate(alice, carol),
    replicate(alice, david),
  ])
    .then(() => t.pass('replicated'))
    .catch((err) => t.error(err))

  await bob.tribes2
    .acceptInvite(groupId)
    .then(() => t.pass('bob accepted invite'))
    .catch((err) => t.error(err))

  await Promise.all([
    alice.tribes2.excludeMembers(groupId, [carolRootId]),
    bob.tribes2.excludeMembers(groupId, [carolRootId]),
  ])
    .then(() => t.pass('alice and bob excluded carol'))
    .catch((err) => t.error(err))

  const { key: aliceForkPostId } = await alice.tribes2
    .publish({
      type: 'test',
      text: 'alice fork post',
      recps: [groupId],
    })
    .then((res) => {
      t.pass('alice published in her fork')
      return res
    })
    .catch((err) => t.error(err))
  const { writeKey: aliceForkKey } = await alice.tribes2
    .get(groupId)
    .then((res) => {
      t.pass('alice got info on her fork')
      return res
    })
    .catch((err) => t.error(err))
  const aliceForkSecret = aliceForkKey.key.toString('base64')

  const { key: bobForkPostId } = await bob.tribes2
    .publish({
      type: 'test',
      text: 'bob fork post',
      recps: [groupId],
    })
    .then((res) => {
      t.pass('bob posted in his fork')
      return res
    })
    .catch((err) => t.error(err))
  const { writeKey: bobForkKey } = await bob.tribes2
    .get(groupId)
    .then((res) => {
      t.pass('bob got info on his fork')
      return res
    })
    .catch((err) => t.error(err))
  const bobForkSecret = bobForkKey.key.toString('base64')

  await Promise.all([
    replicate(alice, bob),
    replicate(alice, carol),
    replicate(alice, david),
  ])
    .then(() => t.pass('replicated'))
    .catch((err) => t.error(err))

  const addDavid = await alice.tribes2
    .addMembers(groupId, [davidRootId])
    .then((res) => {
      t.pass('david got added to the group by alice')
      return res
    })
    .catch((err) => t.error(err))

  t.equal(addDavid.length, 2, 'David got added to both forks')

  const adds = await Promise.all(
    addDavid.map((add) => p(alice.db.get)(add.key))
  )
    .then((res) => {
      t.pass('alice got her additions of david')
      return res
    })
    .catch((err) => t.error(err))
  const addContents = adds.map((add) => add.content)

  const addAliceFork = addContents.find(
    (content) => content.secret === aliceForkSecret
  )
  t.equal(
    addAliceFork.secret,
    aliceForkSecret,
    "gave david the secret to alice's fork"
  )
  t.deepEqual(
    addAliceFork.oldSecrets,
    [firstEpochSecret],
    "gave david the secret to the initial epoch, in the addition to alice's fork"
  )

  const addBobFork = addContents.find(
    (content) => content.secret === bobForkSecret
  )
  t.equal(
    addBobFork.secret,
    bobForkSecret,
    "gave david the secret to bob's fork"
  )
  t.deepEqual(
    addBobFork.oldSecrets,
    [firstEpochSecret],
    "gave david the secret to the initial epoch, in the addition to bob's fork"
  )

  await replicate(alice, david)
    .then(() => t.pass('replicated'))
    .catch((err) => t.error(err))

  await david.tribes2
    .acceptInvite(groupId)
    .then(() => t.pass('david accepted invite'))
    .catch((err) => t.error(err))

  const bobForkMsg = await p(david.db.get)(bobForkPostId)
    .then((res) => {
      t.pass("david got bob's post in his fork")
      return res
    })
    .catch((err) => t.error(err))
  t.notEquals(
    typeof bobForkMsg.content,
    'string',
    "david decrypted the msg in bob's fork"
  )

  const aliceForkMsg = await p(david.db.get)(aliceForkPostId)
    .then((res) => {
      t.pass("david got alice's post in her fork")
      return res
    })
    .catch((err) => t.error(err))
  t.notEquals(
    typeof aliceForkMsg.content,
    'string',
    "david decrypted the msg in alice's fork"
  )

  const firstEpochMsg = await p(david.db.get)(firstEpochPostId)
    .then((res) => {
      t.pass("david got alice's post in the initial epoch")
      return res
    })
    .catch((err) => t.error(err))
  t.notEquals(
    typeof firstEpochMsg.content,
    'string',
    'david decrypted the msg in the first epoch'
  )

  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
    p(david.close)(true),
  ])
    .then(() => t.pass('clients got closed'))
    .catch((err) => t.error(err))
})
