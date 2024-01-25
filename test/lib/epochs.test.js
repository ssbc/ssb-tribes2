// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { promisify: p } = require('util')
const pull = require('pull-stream')
const { where, type, descending, toPullStream } = require('ssb-db2/operators')
const { fromMessageSigil } = require('ssb-uri2')

const { Testbot: Server, replicate, Run } = require('../helpers')
const Epochs = require('../../lib/epochs')

function getRootIds(peers) {
  return Promise.all(
    peers.map((peer) => p(peer.metafeeds.findOrCreate)())
  ).then((feeds) => feeds.map((feed) => feed.id))
}
function closeAll(peers) {
  return Promise.all(peers.map((peer) => p(peer.close)(true)))
}

test('lib/epochs (getEpochs, getMembers)', async (t) => {
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  const [alice, ...others] = peers

  async function sync(label) {
    return run(`(sync ${label})`, replicate(peers), { isTest: false })
  }
  t.teardown(async () => await closeAll(peers))

  const [aliceId, bobId, oscarId] = await getRootIds(peers)
  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )

  const group = await run('alice creates a group', alice.tribes2.create({}))
  t.deepEqual(
    await Epochs(alice).getEpochs(group.id),
    [
      {
        id: group.root,
        previous: null,
        secret: group.writeKey.key,
        author: aliceId,
      },
    ],
    'there is 1 epoch'
  )

  const liveMembers = []
  pull(
    Epochs(alice).getMembers.stream(group.root, { live: true }), // epoch zero root
    pull.drain((state) => liveMembers.unshift(state))
  )
  const excpected0 = { added: [aliceId], toExclude: [] }
  // group.root = epoch zero id
  t.deepEqual(
    await Epochs(alice).getMembers(group.root),
    excpected0,
    'group members: alice'
  )
  t.deepEqual(liveMembers[0], excpected0, 'group members: alice (live)')

  await sync('to get Additions feeds')

  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
  )
  await sync('to propogate invites')
  await run(
    'others accept invites',
    Promise.all(others.map((peer) => peer.tribes2.acceptInvite(group.id)))
  )
  await sync('to see acceptance')
  const expected1 = { added: [aliceId, bobId, oscarId], toExclude: [] }
  t.deepEqual(
    await Epochs(alice).getMembers(group.root),
    expected1,
    'epoch 0 members: alice, bob, oscar'
  )
  t.deepEqual(
    liveMembers[0],
    expected1,
    'epoch 0 members: alice, bob, oscar (live)'
  )

  await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [oscarId], {})
  )
  await sync('exclusion')

  const epochs = await Epochs(alice).getEpochs(group.id)
  const groupUpdated = await alice.tribes2.get(group.id)
  const [lastGroupInitId] = await pull(
    alice.db.query(where(type('group/init')), descending(), toPullStream()),
    pull.map((m) => fromMessageSigil(m.key)),
    pull.take(1),
    pull.collectAsPromise()
  )

  t.deepEqual(
    epochs,
    [
      {
        id: group.root,
        previous: null,
        secret: group.writeKey.key,
        author: aliceId,
      },
      {
        id: lastGroupInitId,
        previous: [group.root],
        secret: groupUpdated.writeKey.key,
        author: aliceId,
      },
    ],
    'there are 2 epochs'
  )

  const expected2 = { added: [aliceId, bobId, oscarId], toExclude: [oscarId] }
  t.deepEqual(
    await Epochs(alice).getMembers(epochs[0].id),
    expected2,
    'epoch 0 members: alice, bob, oscar (note toExclude oscar)'
  )
  t.deepEqual(
    liveMembers[0],
    expected2,
    'epoch 0 members: alice, bob, oscar (note toExclude oscar) (live)'
  )
  t.deepEqual(
    await Epochs(alice).getMembers(epochs[1].id),
    { added: [aliceId, bobId], toExclude: [] },
    'epoch 1 members: alice, bob'
  )

  t.end()
})

test('lib/epochs (getMissingMembers)', async (t) => {
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  const [alice, ...others] = peers

  async function sync(label) {
    return run(
      `(sync ${label})`,
      Promise.all(others.map((peer) => replicate(alice, peer))),
      { isTest: false }
    )
  }
  t.teardown(async () => await closeAll(peers))

  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )
  const rootFeeds = await Promise.all(
    peers.map((peer) => p(peer.metafeeds.findOrCreate)())
  )
  const [, bobId, oscarId] = rootFeeds.map((feed) => feed.id)

  const group = await run('alice creates a group', alice.tribes2.create({}))
  await sync('to get Additions feeds')
  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
  )
  await sync('to propogate invites')
  await run(
    'others accept invites',
    Promise.all(others.map((peer) => peer.tribes2.acceptInvite(group.id)))
  )
  await sync('to see acceptance')

  t.deepEqual(
    await Epochs(alice).getMissingMembers(group.id),
    [],
    'no missing members'
  )

  // alice removes oscar
  // HACK: hook create to drop bob from the re-addition
  alice.db.create.hook((create, args) => {
    const { content } = args[0]
    if (content.type === 'group/add-member') {
      content.recps = content.recps.filter((recp) => recp !== bobId)
    }
    create.apply(this, args)
  })
  await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [oscarId], {})
  )

  const newEpoch = await Epochs(alice)
    .getEpochs(group.id)
    .then((epochs) => epochs.find((epoch) => epoch.previous))

  t.deepEqual(
    await Epochs(alice).getMissingMembers(group.id),
    [
      {
        epoch: newEpoch.id,
        secret: newEpoch.secret,
        missing: [bobId],
      },
    ],
    'bob is missing from the new epoch'
  )

  t.end()
})

test('lib/epochs (tieBreak)', async (t) => {
  const { tieBreak } = Epochs({})

  const A = {
    secret: Buffer.from(
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'base64'
    ),
  }
  const B = {
    secret: Buffer.from(
      'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=',
      'base64'
    ),
  }
  const C = {
    secret: Buffer.from(
      'YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY=',
      'base64'
    ),
  }

  t.deepEqual(tieBreak([A, B, C]), A)
  t.deepEqual(tieBreak([C, B, A]), A)
  t.deepEqual(tieBreak([C, B]), B)
  t.deepEqual(tieBreak([B]), B)

  t.end()
})

test('lib/epochs (getPreferredEpoch - 4.4. same membership)', async (t) => {
  // alice starts a group, adds bob + oscar
  // simultaneously:
  //   - alice excludes oscar
  //   - bob exlcudes oscar
  // there is a forked state, bob + oscar agree on which one to use
  const run = Run(t)

  // <setup>
  const peers = [
    Server({ name: 'alice' }),
    Server({ name: 'bob' }),
    Server({ name: 'oscar' }),
  ]
  t.teardown(async () => await closeAll(peers))

  const [alice, bob, oscar] = peers
  const [bobId, oscarId] = await getRootIds([bob, oscar])
  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )

  const group = await run('alice creates a group', alice.tribes2.create({}))

  await run('(sync dm feeds)', replicate(alice, bob, oscar))

  await run(
    'alice invites bob, oscar',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
  )

  await run('(sync invites)', replicate(alice, bob, oscar))

  await run(
    'others accept invites',
    Promise.all([
      bob.tribes2.acceptInvite(group.id),
      oscar.tribes2.acceptInvite(group.id),
    ])
  )
  // </setup>

  const livePreferredEpochs = []
  let testsRunning = true
  pull(
    Epochs(alice).getPreferredEpoch.stream(group.id, { live: true }),
    pull.drain(
      (epoch) => livePreferredEpochs.unshift(epoch),
      (err) => {
        if (err && testsRunning) t.error(err, 'getPreferredEpoch.stream smooth')
      }
    )
  )

  const epochs0 = await Epochs(oscar).getEpochs(group.id)

  t.deepEqual(
    await Epochs(oscar).getPreferredEpoch(group.id),
    epochs0[0],
    'getPreferredEpoch (before exclusion)'
  )
  t.deepEqual(
    livePreferredEpochs[0],
    epochs0[0],
    'getPreferredEpoch (before exclusion) (live)'
  )

  await run(
    'alice and bob both exclude oscar (fork!)',
    Promise.all([
      alice.tribes2.excludeMembers(group.id, [oscarId], {}),
      bob.tribes2.excludeMembers(group.id, [oscarId], {}),
    ])
  )
  // alice has not sync'd so we expect the the preferredEpoch to just be
  // the current new tip
  const expected1 = await Epochs(alice)
    .getTipEpochs(group.id)
    .then((tips) => tips[0]) // there is only one she knows about

  t.deepEqual(
    await Epochs(alice).getPreferredEpoch(group.id),
    expected1,
    'getPreferredEpoch (before fork sync)'
  )
  t.deepEqual(
    livePreferredEpochs[0],
    expected1,
    'getPreferredEpoch (before fork sync) (live)'
  )

  await run('(sync exclusion)', replicate(alice, bob))

  await p(setTimeout)(500)

  const expected2 = await Epochs(alice)
    .getTipEpochs(group.id)
    .then((tips) => Epochs(alice).tieBreak(tips))

  t.deepEqual(
    await Epochs(alice).getPreferredEpoch(group.id),
    expected2,
    'getPreferredEpoch'
  )
  t.deepEqual(livePreferredEpochs[0], expected2, 'getPreferredEpoch (live)')

  t.deepEqual(
    await Epochs(alice).getPreferredEpoch(group.id),
    await Epochs(bob).getPreferredEpoch(group.id),
    'getPreferredEpoch (alice + bob agree)'
  )

  // TODO need to test epochs > 2

  testsRunning = false
  t.end()
})

test('lib/epochs (getPreferredEpoch - 4.5. subset membership)', async (t) => {
  // alice starts a group, adds bob, carol, oscar
  // simultaneously:
  //   - alice excludes oscar
  //   - bob exlcudes carol, oscar
  // everyone agrees on the preferred epoch (the one bob made)

  const run = Run(t)

  // <setup>
  const peers = [
    Server({ name: 'alice' }),
    Server({ name: 'bob' }),
    Server({ name: 'carol' }),
    Server({ name: 'oscar' }),
  ]
  t.teardown(async () => await closeAll(peers))

  const [alice, bob, carol, oscar] = peers
  const [bobId, carolId, oscarId] = await getRootIds([bob, carol, oscar])
  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )

  const group = await run('alice creates a group', alice.tribes2.create({}))

  await run('(sync dm feeds)', replicate(alice, bob, carol, oscar))

  await run(
    'alice invites bob, carol, oscar',
    alice.tribes2.addMembers(group.id, [bobId, carolId, oscarId], {})
  )

  await run('(sync dm feeds)', replicate(alice, bob, carol, oscar))

  await run(
    'others accept invites',
    Promise.all([
      bob.tribes2.acceptInvite(group.id),
      oscar.tribes2.acceptInvite(group.id),
    ])
  )
  // </setup>

  await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [oscarId], {})
  )
  await run(
    'bob excludes carol, oscar',
    bob.tribes2.excludeMembers(group.id, [carolId, oscarId], {})
  )

  await run('(sync exclusions)', replicate(alice, bob))

  const expectedEpoch = await Epochs(alice)
    .getTipEpochs(group.id)
    .then((tips) => tips.find((tip) => tip.author === bobId))

  t.deepEqual(
    await Epochs(alice).getPreferredEpoch(group.id),
    expectedEpoch,
    'getPreferredEpoch correct'
  )

  t.deepEqual(
    await Epochs(alice).getPreferredEpoch(group.id),
    await Epochs(bob).getPreferredEpoch(group.id),
    'alice and bob agree'
  )

  t.end()
})

test('lib/epochs (getPreferredEpoch - 4.6. overlapping membership)', async (t) => {
  // alice starts a group, adds bob, carol, oscar
  // simultaneously:
  //   - alice excludes oscar
  //   - bob exlcudes carol
  //
  // there is no preferred epoch, you will need to exclude members down to intersection

  const run = Run(t)

  // <setup>
  const peers = [
    Server({ name: 'alice' }),
    Server({ name: 'bob', disjointResolveDelay: 1000 }),
    Server({ name: 'carol' }),
    Server({ name: 'oscar' }),
  ]
  t.teardown(async () => await closeAll(peers))

  const [alice, bob, carol, oscar] = peers
  const [bobId, carolId, oscarId] = await getRootIds([bob, carol, oscar])
  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )

  const group = await run('alice creates a group', alice.tribes2.create({}))

  await run('(sync dm feeds)', replicate(alice, bob, carol, oscar))

  await run(
    'alice invites bob, carol, oscar',
    alice.tribes2.addMembers(group.id, [bobId, carolId, oscarId], {})
  )

  await run('(sync dm feeds)', replicate(alice, bob, carol, oscar))

  await run(
    'others accept invites',
    Promise.all([
      bob.tribes2.acceptInvite(group.id),
      carol.tribes2.acceptInvite(group.id),
      oscar.tribes2.acceptInvite(group.id),
    ])
  )
  // </setup>

  await Promise.all([
    run(
      'alice excludes oscar',
      alice.tribes2.excludeMembers(group.id, [oscarId], {})
    ),
    run(
      'bob excludes carol',
      bob.tribes2.excludeMembers(group.id, [carolId], {})
    ),
  ])

  await run('(sync exclusions)', replicate(alice, bob))

  const DELAY = 5000
  console.log('sleep', DELAY) // eslint-disable-line
  await p(setTimeout)(DELAY)

  await run('(sync conflict resolution)', replicate(alice, bob))

  t.equal(
    (await Epochs(alice).getTipEpochs(group.id)).length,
    1,
    'there is only 1 tip'
  )

  t.deepEqual(
    await Epochs(alice).getPreferredEpoch(group.id),
    await Epochs(bob).getPreferredEpoch(group.id),
    'alice and bob agree'
  )

  t.end()
})

test('lib/epochs (getPreferredEpoch - 4.7. disjoint membership)', async (t) => {
  // there is no conflict in this case (doesn't need testing?)

  // alice starts a group, adds bob, carol, oscar
  // simultaneously:
  //   - alice excludes carol, oscar
  //   - oscar excludes alice, bob
  //
  // the group split!

  const run = Run(t)

  // <setup>
  const peers = [
    Server({ name: 'alice' }),
    Server({ name: 'bob' }),
    Server({ name: 'carol' }),
    Server({ name: 'oscar' }),
  ]
  t.teardown(async () => await closeAll(peers))

  const [alice, bob, carol, oscar] = peers
  const [aliceId, bobId, carolId, oscarId] = await getRootIds([
    alice,
    bob,
    carol,
    oscar,
  ])
  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )

  const group = await run('alice creates a group', alice.tribes2.create({}))

  await run('(sync dm feeds)', replicate(alice, bob, carol, oscar))

  await run(
    'alice invites bob, carol, oscar',
    alice.tribes2.addMembers(group.id, [bobId, carolId, oscarId], {})
  )

  await run('(sync dm feeds)', replicate(alice, bob, carol, oscar))

  await run(
    'others accept invites',
    Promise.all([
      bob.tribes2.acceptInvite(group.id),
      carol.tribes2.acceptInvite(group.id),
      oscar.tribes2.acceptInvite(group.id),
    ])
  )
  // </setup>

  await Promise.all([
    run(
      'alice excludes carol, oscar',
      alice.tribes2.excludeMembers(group.id, [carolId, oscarId], {})
    ),
    run(
      'oscar excludes alice, bob',
      oscar.tribes2.excludeMembers(group.id, [aliceId, bobId], {})
    ),
  ])

  await run(
    '(sync exclusions)',
    Promise.all([
      replicate(alice, bob),
      replicate(oscar, carol),
      replicate(alice, oscar),
    ])
  )

  const DELAY = 1000
  console.log('sleep', DELAY) // eslint-disable-line
  await p(setTimeout)(DELAY)

  const aliceTips = await Epochs(alice).getTipEpochs(group.id)
  const oscarTips = await Epochs(oscar).getTipEpochs(group.id)
  t.equal(aliceTips.length, 1, 'alice sees only one tip')
  t.equal(oscarTips.length, 1, 'oscar sees only one tip')

  const [alicePreferred, bobPreferred, carolPreferred, oscarPreferred] =
    await Promise.all(
      peers.map((peer) => Epochs(peer).getPreferredEpoch(group.id))
    )

  t.deepEqual(alicePreferred, bobPreferred, 'alice and bob agree epoch')
  t.deepEqual(carolPreferred, oscarPreferred, 'carol and oscar agree epoch')
  t.notDeepEqual(alicePreferred, oscarPreferred, 'the group is split')

  t.end()
})
