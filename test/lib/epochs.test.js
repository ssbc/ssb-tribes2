// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { promisify: p } = require('util')
const pull = require('pull-stream')
const { where, type, descending, toPullStream } = require('ssb-db2/operators')
const { fromMessageSigil } = require('ssb-uri2')

const Server = require('../helpers/testbot')
const replicate = require('../helpers/replicate')
const Epochs = require('../../lib/epochs')

function Run(t) {
  // this function takes care of running a promise and logging
  // (or testing) that it happens and any errors are handled
  return async function run(label, promise, opts = {}) {
    const { isTest = true, timer = false, logError = false } = opts

    if (timer) console.time('> ' + label)
    return promise
      .then((res) => {
        if (isTest) t.pass(label)
        return res
      })
      .catch((err) => {
        t.error(err, label)
        if (logError) console.error(err)
      })
      .finally(() => timer && console.timeEnd('> ' + label))
  }
}

function getRootIds(peers) {
  return Promise.all(
    peers.map((peer) => p(peer.metafeeds.findOrCreate)())
  ).then((feeds) => feeds.map((feed) => feed.id))
}

test('lib/epochs (getEpochs, getMembers)', async (t) => {
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
  t.teardown(() => peers.forEach((peer) => peer.close(true)))

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

  let liveMembersState = {}
  pull(
    Epochs(alice).getMembers.stream(group.root, { live: true }), // epoch zero root
    pull.drain((state) => {
      liveMembersState = state
    })
  )
  const excpected0 = { added: [aliceId], toExclude: [] }
  // group.root = epoch zero id
  t.deepEqual(
    await Epochs(alice).getMembers(group.root),
    excpected0,
    'group members: alice'
  )
  t.deepEqual(liveMembersState, excpected0, 'group members: alice (live)')

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
    liveMembersState,
    expected1,
    'epoch 0 members: alice, bob, oscar (live)'
  )

  // alice removes oscar
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
    liveMembersState,
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
  t.teardown(() => peers.forEach((peer) => peer.close(true)))

  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )
  const rootFeeds = await Promise.all(
    peers.map((peer) => p(peer.metafeeds.findOrCreate)())
  )
  const [aliceId, bobId, oscarId] = rootFeeds.map((feed) => feed.id)

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
    // console.log('create', args[0].content)
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
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  t.teardown(() => peers.forEach((peer) => peer.close(true)))

  const [alice, bob, oscar] = peers
  const [aliceId, bobId, oscarId] = await getRootIds(peers)
  await run(
    'start tribes',
    Promise.all(peers.map((peer) => peer.tribes2.start()))
  )

  const group = await run('alice creates a group', alice.tribes2.create({}))

  await run(
    '(sync dm feeds)',
    Promise.all([replicate(alice, bob), replicate(alice, oscar)])
  )

  await run(
    'alice invites bob, oscar',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
  )

  await run(
    '(sync invites)',
    Promise.all([replicate(alice, bob), replicate(alice, oscar)])
  )

  await run(
    'others accept invites',
    Promise.all([
      bob.tribes2.acceptInvite(group.id),
      oscar.tribes2.acceptInvite(group.id),
    ])
  )

  let livePreferredEpoch = {}
  pull(
    Epochs(oscar).getPreferredEpoch.stream(group.id, { live: true }),
    pull.drain(
      (epoch) => {
        livePreferredEpoch = epoch
      },
      (err) => {}
    )
  )

  const epochs0 = await Epochs(oscar).getEpochs(group.id)

  t.deepEqual(
    await Epochs(oscar).getPreferredEpoch(group.id),
    epochs0[0],
    'getPreferredEpoch (before exclusion)'
  )
  t.deepEqual(
    livePreferredEpoch,
    epochs0[0],
    'getPreferredEpoch (before exclusion) (live)'
  )

  await run(
    'bob and oscar both exclude alice (mutiny, fork)!',
    Promise.all([
      bob.tribes2.excludeMembers(group.id, [aliceId], {}),
      oscar.tribes2.excludeMembers(group.id, [aliceId], {}),
    ])
  )

  const epochs1 = await Epochs(oscar)
    .getEpochs(group.id)
    .then((epochs) => epochs.filter((epoch) => epoch.author != aliceId))

  t.deepEqual(
    await Epochs(oscar).getPreferredEpoch(group.id),
    epochs1[0],
    'getPreferredEpoch (before fork sync)'
  )
  t.deepEqual(
    livePreferredEpoch,
    epochs1[0],
    'getPreferredEpoch (before fork sync) (live)'
  )

  await run('(sync exclusion)', replicate(bob, oscar))

  const epochs2 = await Epochs(oscar)
    .getEpochs(group.id)
    .then((epochs) => epochs.filter((epoch) => epoch.author != aliceId))
  const preferredEpoch = Epochs({}).tieBreak(epochs2)

  t.deepEqual(
    await Epochs(oscar).getPreferredEpoch(group.id),
    preferredEpoch,
    'getPreferredEpoch'
  )
  t.deepEqual(livePreferredEpoch, preferredEpoch, 'getPreferredEpoch (live)')

  // TODO need to test epochs > 2

  t.end()
})

test.skip('lib/epochs (getPreferredEpoch - 4.5. subset membership)', async (t) => {
  // the choice is the epoch which is a subset of all the others

  t.end()
})

test.skip('lib/epochs (getPreferredEpoch - 4.6. overlapping membership)', async (t) => {
  // there is no preferred epoch, you will need to choose choose a winner
  // and exclude some members
  // (not sure what the API should be here)

  t.end()
})

test.skip('lib/epochs (getPreferredEpoch - 4.7. disjoint membership)', async (t) => {
  // there is no conflict in this case (doesn't need testing?)

  t.end()
})
