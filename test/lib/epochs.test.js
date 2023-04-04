const test = require('tape')
const { promisify: p } = require('util')

const Server = require('../helpers/testbot')
const replicate = require('../helpers/replicate')

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

test('lib/epochs', async t => {
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

  let epochs = await run(
    'alice gets epochs',
    alice.tribes2.getEpochs(group.id)
  )
  t.deepEqual(
    epochs,
    [{
      key: group.root,
      previous: null,
      epochKey: group.writeKey.key,
      author: epochs[0].author // CHEAT
      // TODO where can we get the author feed from... do we need it?
    }],
    'there is 1 epoch'
  )

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
  await run(
    'alice excludes oscar',
    alice.tribes2.excludeMembers(group.id, [rootIds[1]], {})
  )
  await sync('replication (exclusion)')

  epochs = await run(
    'alice gets epochs',
    alice.tribes2.getEpochs(group.id)
  )

  const groupUpdated = await alice.tribes2.get(group.id)

  t.deepEqual(
    epochs,
    [
      {
        key: group.root,
        previous: null,
        epochKey: group.writeKey.key,
        author: epochs[0].author // CHEAT
      },
      {
        key: epochs[1].key, // CHEAT ...get this from excludeMembers?
        previous: [group.root],
        epochKey: groupUpdated.writeKey.key,
        author: epochs[1].author // CHEAT
      }
    ],
    'there are 2 epochs'
  )

  t.end()
})
