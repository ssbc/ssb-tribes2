// SPDX-FileCopyrightText: 2022 Mix Irving
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

function Run (t) {
  // this function takes care of running a promise and logging
  // (or testing) that it happens and any errors are handled
  return async function run (label, promise, opts = {}) {
    const {
      isTest = true,
      timer = false,
      logError = false
    } = opts

    if (timer) console.time('> ' + label)
    return promise
      .then(res => {
        if (isTest) t.pass(label)
        return res
      })
      .catch(err => {
        t.error(err, label)
        if (logError) console.error(err)
      })
      .finally(() => timer && console.timeEnd('> ' + label))
  }
}

test('lib/epochs (getEpochs, getMembers)', async t => {
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  const [alice, ...others] = peers

  async function sync (label) {
    return run(
      `replicate (${label})`,
      Promise.all(others.map(peer => replicate(alice, peer))),
      { isTest: false }
    )
  }
  t.teardown(() => peers.forEach(peer => peer.close(true)))

  await run(
    'start tribes',
    Promise.all(peers.map(peer => peer.tribes2.start())),
  )
  const rootFeeds = await Promise.all(
    peers.map(peer => p(peer.metafeeds.findOrCreate)())
  )
  const [aliceId, bobId, oscarId] = rootFeeds.map(feed => feed.id)

  const group = await run(
    'alice creates a group',
    alice.tribes2.create({})
  )
  t.deepEqual(
    await Epochs(alice).getEpochs(group.id),
    [{
      id: group.root,
      previous: null,
      epochKey: group.writeKey.key,
      author: aliceId
    }],
    'there is 1 epoch'
  )
  t.deepEqual(
    await Epochs(alice).getMembers(group.root), // epoch zero root
    { added: [aliceId], toExclude: [] },
    'group members: alice'
  )

  await sync('to get Additions feeds')

  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
  )
  await sync('to propogate invites')
  await run(
    'others accept invites',
    Promise.all(
      others.map(peer => peer.tribes2.acceptInvite(group.id))
    )
  )
  await sync('to see acceptance')
  t.deepEqual(
    await Epochs(alice).getMembers(group.root), // epoch zero root
    { added: [aliceId, bobId, oscarId], toExclude: [] },
    'epoch 0 members: alice, bob, oscar'
  )

  // alice removes oscar
  await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [oscarId], {})
  )
  await sync('exclusion')

  const epochs = await Epochs(alice).getEpochs(group.id)
  const groupUpdated = await alice.tribes2.get(group.id)
  const lastGroupInitId = await new Promise((resolve, reject) => {
    pull(
      alice.db.query(
        where(type('group/init')),
        descending(),
        toPullStream()
      ),
      pull.map(m => fromMessageSigil(m.key)),
      pull.take(1),
      pull.collect((err, keys) => {
        err ? reject(err) : resolve(keys[0])
      })
    )
  })
  t.deepEqual(
    epochs,
    [
      {
        id: group.root,
        previous: null,
        epochKey: group.writeKey.key,
        author: aliceId
      },
      {
        id: lastGroupInitId,
        previous: [group.root],
        epochKey: groupUpdated.writeKey.key,
        author: aliceId
      }
    ],
    'there are 2 epochs'
  )
  t.deepEqual(
    await Epochs(alice).getMembers(epochs[0].id),
    { added: [aliceId, bobId, oscarId], toExclude: [oscarId] },
    'epoch 0 members: alice, bob, oscar (note toExclude oscar)'
  )
  t.deepEqual(
    await Epochs(alice).getMembers(epochs[1].id),
    { added: [aliceId, bobId], toExclude: [] },
    'epoch 1 members: alice, bob'
  )

  t.end()
})

test('lib/epochs (getMissingMembers)', async t => {
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  const [alice, ...others] = peers

  async function sync (label) {
    return run(
      `replicate (${label})`,
      Promise.all(others.map(peer => replicate(alice, peer))),
      { isTest: false }
    )
  }
  t.teardown(() => peers.forEach(peer => peer.close(true)))

  await run(
    'start tribes',
    Promise.all(peers.map(peer => peer.tribes2.start())),
  )
  const rootFeeds = await Promise.all(
    peers.map(peer => p(peer.metafeeds.findOrCreate)())
  )
  const [aliceId, bobId, oscarId] = rootFeeds.map(feed => feed.id)

  const group = await run(
    'alice creates a group',
    alice.tribes2.create({})
  )
  await sync('to get Additions feeds')
  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
  )
  await sync('to propogate invites')
  await run(
    'others accept invites',
    Promise.all(
      others.map(peer => peer.tribes2.acceptInvite(group.id))
    )
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
      content.recps = content.recps.filter(recp => recp !== bobId)
    }
    // console.log('create', args[0].content)
    create.apply(this, args)
  })
  await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [oscarId], {})
  )

  const newEpoch = await Epochs(alice).getEpochs(group.id)
    .then(epochs => epochs.find(epoch => epoch.previous))

  t.deepEqual(
    await Epochs(alice).getMissingMembers(group.id),
    [
      {
        epoch: newEpoch.id,
        epochKey: newEpoch.epochKey,
        missing: [bobId]
      }
    ],
    'bob is missing from the new epoch'
  )

  t.end()
})
