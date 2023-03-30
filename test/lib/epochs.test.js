const test = require('tape')
const { promisify: p } = require('util')

const Server = require('../helpers/testbot')
const replicate = require('../helpers/replicate')

function Run (t) {
  return async function run (label, promise, opts = {}) {
    const { runTimer = true } = opts

    if (runTimer) console.time(label)
    return promise
      .then(res => {
        t.pass(label)
        return res
      })
      .catch(err => t.error(err, label))
      .finally(() => runTimer && console.timeEnd(label))
  }
}

test.only('lib/epochs', async t => {
  t.plan(7)
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  t.teardown(() => peers.forEach(peer => peer.close(true)))

  const [alice, ...others] = peers
  // const [bob, oscar] = others

  await run(
    'start tribes',
    Promise.all(
      peers.map(peer => p(peer.tribes2.start)())
    )
  )

  let group = await run(
    'alice creates a group',
    p(alice.tribes2.create)({})
  )

  await run(
    'alice replicates peers (to get Additions feeds)',
    Promise.all(
      others.map(peer => replicate(alice, peer))
    )
  )

  // alice invites peers
  const rootFeeds = await Promise.all(
    others.map(peer => p(peer.metafeeds.findOrCreate)())
  )
  const rootIds = rootFeeds.map(feed => feed.id)
  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, rootIds, {})
  )

  await run(
    'alice replicates peers (to propogate invites)',
    Promise.all(
      others.map(peer => replicate(alice, peer))
    )
  )

  await run(
    'peers accept invites',
    Promise.all(
      others.map(peer => peer.tribes2.acceptInvite(group.id))
    )
  )

  // await p(setTimeout)(1000)

  await run(
    'alice replicates peers (to see acceptance)',
    Promise.all(
      others.map(peer => replicate(alice, peer))
    )
  )

  await run(
    'alice replicates peers (to see acceptance)',
    Promise.all(
      others.map(peer => replicate(alice, peer))
    )
  )
})
