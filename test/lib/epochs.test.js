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
  const rootFeeds = await Promise.all(
    peers.map(peer => p(peer.metafeeds.findOrCreate)())
  )
  const [aliceId, bobId, oscarId] = rootFeeds.map(feed => feed.id)

  const group = await run(
    'alice creates a group',
    alice.tribes2.create({})
  )

  let epochs = await run(
    'alice gets epochs',
    Epochs(alice).getEpochs(group.id)
  )

  t.deepEqual(
    epochs,
    [{
      id: group.root,
      previous: null,
      epochKey: group.writeKey.key,
      author: aliceId
    }],
    'there is 1 epoch'
  )

  await sync('replication (to get Additions feeds)')

  await run(
    'alice invites other peers to group',
    alice.tribes2.addMembers(group.id, [bobId, oscarId], {})
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
    alice.tribes2.excludeMembers(group.id, [oscarId], {})
  )
  await sync('replication (exclusion)')

  epochs = await run(
    'alice gets epochs',
    Epochs(alice).getEpochs(group.id)
  )

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

  t.end()
})
