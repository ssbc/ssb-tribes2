const test = require('tape')
const { promisify: p } = require('util')

const Server = require('../helpers/testbot')
const replicate = require('../helpers/replicate')

function Run (t) {
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
        else console.log(' ', label)
        return res
      })
      .catch(err => {
        t.error(err, label)
        if (logError) console.error(err)
      })
      .finally(() => timer && console.timeEnd('> ' + label))
  }
}

test.only('lib/epochs', async t => {
  const run = Run(t)

  const peers = [Server(), Server(), Server()]
  t.teardown(() => peers.forEach(peer => peer.close(true)))

  const [alice, ...others] = peers
  const [bob, oscar] = others

  async function sync (label) {
    return run(
      label,
      Promise.all(others.map(peer => replicate(alice, peer))),
      { isTest: false }
    )
  }

  await run(
    'start tribes',
    Promise.all(peers.map(peer => p(peer.tribes2.start)())),
  )

  const group = await run(
    'alice creates a group',
    p(alice.tribes2.create)({})
  )

  let epochGraph = await run(
    'alice gets epochs',
    alice.tribes2.getEpochs(group.id)
  )
  console.log(JSON.stringify(epochGraph, null, 2))

  await sync('replication (to get Additions feeds)')

  // alice adds peers
  const rootFeeds = await Promise.all(
    others.map(peer => p(peer.metafeeds.findOrCreate)())
  )
  const rootIds = rootFeeds.map(feed => feed.id)
  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, rootIds, {})
  )
  await sync('replication (to propogate invites)')
  await run(
    'others accept invites',
    Promise.all(
      others.map(peer => peer.tribes2.acceptInvite(group.id))
    )
  )
  await sync('replication (to see acceptance)')

  // alice removes oscar
  const epochNext = await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [rootIds[1]], {})
  )
  await sync('replication (exclusion)')

  epochGraph = await run(
    'alice gets epochs',
    alice.tribes2.getEpochs(group.id)
  )
  console.log(JSON.stringify(epochGraph, null, 2))

  t.end()
})
