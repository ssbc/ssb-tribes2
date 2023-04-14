// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const pull = require('pull-stream')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const { where, author, toPromise } = require('ssb-db2/operators')
const { fromMessageSigil } = require('ssb-uri2')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')
const countGroupFeeds = require('./helpers/count-group-feeds')

test('add and exclude a person, post on the new feed', async (t) => {
  // Alice's feeds should look like
  // first: initGroup->excludeBob
  // second: initEpoch->post
  // additions: addAlice->addBob->reAddAlice
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
  t.pass('tribes2 started for both alice and bob')

  const aliceRoot = await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicate their trees')

  const {
    id: groupId,
    root,
    writeKey: writeKey1,
    subfeed: { id: firstFeedId },
  } = await alice.tribes2
    .create()
    .catch((err) => t.error(err, 'alice failed to create group'))

  const addBobMsg = await alice.tribes2
    .addMembers(groupId, [bobRoot.id])
    .catch((err) => t.error(err, 'add member fail'))

  t.equals(
    await p(countGroupFeeds)(alice),
    1,
    'before exclude alice has 1 group feed'
  )

  await alice.tribes2
    .excludeMembers(groupId, [bobRoot.id])
    .catch((err) => t.error(err, 'exclude member fail'))

  t.equals(
    await p(countGroupFeeds)(alice),
    2,
    'after exclude alice has 2 group feeds'
  )

  const {
    value: { author: secondFeedId },
  } = await alice.tribes2
    .publish({
      type: 'test',
      text: 'post',
      recps: [groupId],
    })
    .catch(t.fail)

  t.equals(
    await p(countGroupFeeds)(alice),
    2,
    'alice still has 2 group feeds after publishing on the new feed'
  )

  t.notEquals(
    secondFeedId,
    firstFeedId,
    'feed for publish is different to initial feed'
  )

  const { writeKey: writeKey2 } = await alice.tribes2.get(groupId)

  t.false(writeKey1.key.equals(writeKey2.key), "there's a new key for writing")

  const msgsFromFirst = await alice.db.query(
    where(author(firstFeedId)),
    toPromise()
  )

  const firstContents = msgsFromFirst.map((msg) => msg.value.content)

  t.equal(firstContents.length, 2, '2 messages on first feed')

  const firstInit = firstContents[0]

  t.equal(firstInit.type, 'group/init')
  t.equal(firstInit.groupKey, writeKey1.key.toString('base64'))

  const excludeMsg = firstContents[1]

  t.equal(excludeMsg.type, 'group/exclude')
  t.deepEqual(excludeMsg.excludes, [bobRoot.id])
  t.deepEqual(excludeMsg.recps, [groupId])
  t.deepEqual(excludeMsg.tangles.members, {
    root,
    previous: [fromMessageSigil(addBobMsg.key)],
  })

  const msgsFromSecond = await alice.db.query(
    where(author(secondFeedId)),
    toPromise()
  )

  const secondContents = msgsFromSecond.map((msg) => msg.value.content)

  t.equal(secondContents.length, 2, '2 messages on second (new) feed')

  const secondInit = secondContents[0]

  t.equal(secondInit.type, 'group/init')
  t.equal(secondInit.version, 'v2')
  t.equal(secondInit.groupKey, writeKey2.key.toString('base64'))
  t.deepEqual(secondInit.tangles.members, { root: null, previous: null })
  t.deepEqual(
    secondInit.tangles.epoch,
    { root, previous: [root] },
    'epoch tangle is correct on new epoch init'
  )

  const post = secondContents[1]

  t.equal(post.text, 'post', 'found post on second feed')

  const aliceAdditions = await p(alice.metafeeds.findOrCreate)({
    purpose: 'group/additions',
  })
  const msgsFromAdditions = await alice.db.query(
    where(author(aliceAdditions.id)),
    toPromise()
  )
  const additionsContents = msgsFromAdditions.map((msg) => msg.value.content)

  t.equal(additionsContents.length, 3, '3 messages on additions feed')

  const reinviteMsg = additionsContents[2]

  t.equal(reinviteMsg.type, 'group/add-member')
  t.deepEqual(reinviteMsg.recps, [groupId, aliceRoot.id])

  const secondInitKey = fromMessageSigil(msgsFromSecond[0].key)
  t.deepEqual(
    reinviteMsg.tangles.members,
    {
      root: secondInitKey,
      previous: [secondInitKey],
    },
    'members tangle resets after new epoch'
  )

  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('Verify that you actually get excluded from a group', async (t) => {
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
  t.pass('tribes2 started for both alice and bob')

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicate their trees')

  const { id: groupId } = await alice.tribes2
    .create()
    .catch((err) => t.error(err, 'alice failed to create group'))

  await alice.tribes2
    .addMembers(groupId, [bobRoot.id])
    .catch((err) => t.error(err, 'add member fail'))

  await replicate(alice, bob)

  await bob.tribes2.acceptInvite(groupId).catch(t.error)

  await bob.tribes2
    .publish({
      type: 'test',
      text: 'bob first post',
      recps: [groupId],
    })
    .then(() => t.pass("bob posts in the group while he's in it"))
    .catch(t.error)

  await replicate(alice, bob)

  await alice.tribes2
    .excludeMembers(groupId, [bobRoot.id])
    .catch((err) => t.error(err, 'exclude member fail'))

  const { key: aliceNewEpochPostKey } = await alice.tribes2.publish({
    type: 'shitpost',
    text: 'alicepost',
    recps: [groupId],
  })

  await replicate(alice, bob)

  await p(setTimeout)(500)

  t.pass('replicated, about to publish')

  await bob.tribes2
    .publish({
      type: 'test',
      text: 'bob second post',
      recps: [groupId],
    })
    .then(() =>
      t.fail("Bob posted again in the group even if he's excluded from it")
    )
    .catch(() =>
      t.pass("Bob can't post in the group anymore since he's excluded from it")
    )

  const bobGroups = await pull(
    bob.tribes2.list({ excluded: true }),
    pull.collectAsPromise()
  )
  t.deepEquals(
    bobGroups,
    [{ id: groupId, excluded: true }],
    "bob is excluded from the only group he's been in. sad."
  )

  const bobGotMsg = await p(bob.db.get)(aliceNewEpochPostKey)
  t.equals(
    typeof bobGotMsg.content,
    'string',
    "bob didn't manage to decrypt alice's new message"
  )

  const invites = await pull(bob.tribes2.listInvites(), pull.collectAsPromise())
  t.deepEquals(invites, [], 'Bob has no invites')

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

  await p(alice.close)(true)
  await p(bob.close)(true)
})

test("If you're not the excluder nor the excludee then you should still be in the group and have access to the new epoch", async (t) => {
  // alice creates the group. adds bob and carol. removes bob.
  // bob gets added and is removed
  // carol stays in the group
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

  await alice.tribes2.start()
  await bob.tribes2.start()
  await carol.tribes2.start()
  t.pass('tribes2 started for everyone')

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  await replicate(alice, carol)
  await replicate(bob, carol)
  t.pass('everyone replicates their trees')

  const { id: groupId, writeKey: writeKey1 } = await alice.tribes2
    .create()
    .catch((err) => t.error(err, 'alice failed to create group'))

  await replicate(alice, carol)

  await alice.tribes2
    .addMembers(groupId, [bobRoot.id, carolRoot.id])
    .catch((err) => t.error(err, 'add bob fail'))

  await replicate(alice, carol)

  await carol.tribes2.acceptInvite(groupId)

  await replicate(alice, carol)

  const {
    value: { author: firstFeedId },
  } = await carol.tribes2
    .publish({
      type: 'test',
      text: 'first post',
      recps: [groupId],
    })
    .catch((err) => t.error(err, 'carol failed to publish on first feed'))
  if (firstFeedId) t.pass('carol posted first post')

  await alice.tribes2
    .excludeMembers(groupId, [bobRoot.id])
    .then((res) => {
      t.pass('alice excluded bob')
      return res
    })
    .catch((err) => t.error(err, 'remove member fail'))

  await replicate(alice, carol).catch(t.error)

  // let carol find the new epoch and switch to the new key
  await p(setTimeout)(500)

  const {
    value: { author: secondFeedId },
  } = await carol.tribes2
    .publish({
      type: 'test',
      text: 'second post',
      recps: [groupId],
    })
    .catch(t.fail)
  if (secondFeedId) t.pass('carol posted second post')

  t.notEquals(
    secondFeedId,
    firstFeedId,
    'feed for second publish is different to first publish'
  )

  const { writeKey: writeKey2 } = await carol.tribes2.get(groupId)

  const branches = await pull(
    carol.metafeeds.branchStream({
      root: carolRoot.id,
      old: true,
      live: false,
    }),
    pull.collectAsPromise()
  )

  const groupFeedPurposes = branches
    .filter((branch) => branch.length === 4)
    .map((branch) => branch[3])
    .filter((feed) => feed.recps && feed.purpose.length === 44)
    .map((feed) => feed.purpose)

  t.true(
    groupFeedPurposes.includes(writeKey1.key.toString('base64')),
    'Carol has a feed for the old key'
  )
  t.true(
    groupFeedPurposes.includes(writeKey2.key.toString('base64')),
    'Carol has a feed for the new key'
  )

  await p(alice.close)(true)
  await p(bob.close)(true)
  await p(carol.close)(true)
})

test.only('Can exclude a person in a group with a lot of members', async (t) => {
  const alice = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  const peers = Array.from({ length: 20 }).map(() => Testbot())

  async function sync() {
    await Promise.all(peers.map((peer) => replicate(alice, peer)))
  }

  await alice.tribes2.start()
  await Promise.all(peers.map((peer) => peer.tribes2.start()))

  const peerRoots = await Promise.all(
    peers.map((peer) => p(peer.metafeeds.findOrCreate)())
  ).catch((err) => t.error(err, 'Error getting root feeds for peers'))
  const peerRootIds = peerRoots.map((root) => root.id)
  const [bobRootId, ...otherRootIds] = peerRootIds

  const { id: groupId } = await alice.tribes2.create()

  await sync()

  await alice.tribes2.addMembers(groupId, peerRootIds.slice(0, 10))
  await alice.tribes2.addMembers(groupId, peerRootIds.slice(10))

  await sync()

  await Promise.all(peers.map((peer) => peer.tribes2.acceptInvite(groupId)))

  await alice.tribes2
    .excludeMembers(groupId, [bobRootId])
    .then(() =>
      t.pass('alice was able to exclude bob in a group with many members')
    )
    .catch((err) =>
      t.error(
        err,
        'alice was unable to exclude bob in a group with many members'
      )
    )

  await sync()

  const [bob, ...others] = peers

  const bobGroup = await bob.tribes2.get(groupId)
  t.deepEquals(
    bobGroup,
    { id: groupId, excluded: true },
    'bob is excluded from group'
  )

  await Promise.all(
    others.map((other) => {
      return (async () => {
        const otherGroup = await other.tribes2.get(groupId)

        if (otherGroup.excluded) throw 'got excluded'
        if (otherGroup.readKeys.length !== 2) throw 'not enough readkeys'

        return otherGroup
      })()
    })
  )
    .then(() => t.pass("Others didn't get excluded from the group"))
    .catch(() => t.fail('Others got excluded from the group'))

  // TODO: check that the others actually have access to the new epoch (alice post something there?)

  await p(alice.close)(true)
  await Promise.all(peers.map((peer) => p(peer.close)(true)))
})
