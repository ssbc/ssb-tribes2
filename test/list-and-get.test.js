// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const { promisify: p } = require('util')
const pull = require('pull-stream')
const { isClassicMessageSSBURI, isIdentityGroupSSBURI } = require('ssb-uri2')
const ssbKeys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('tribes.list + tribes.get', (t) => {
  const name = `list-and-get-groups-${Date.now()}`
  let server = Testbot({ name })
  const keys = server.keys

  server.tribes2.create(null, (err, group) => {
    t.error(err, 'create group')

    pull(
      server.tribes2.list(),
      pull.collect(async (err, list) => {
        t.error(err, 'no error')

        const expectedGroup = {
          id: group.id,
          writeKey: group.writeKey,
          readKeys: group.readKeys,
          root: group.root,
        }

        t.deepEqual(list, [expectedGroup], 'lists group ids')

        server.tribes2.get(group.id, (err, actualGroup) => {
          t.error(err, 'no error')

          t.deepEqual(actualGroup, expectedGroup, 'gets group data')

          server.close((err) => {
            t.error(err, 'closes server')

            server = Testbot({ name, rimraf: false, keys })
            pull(
              server.tribes2.list(),
              pull.collect((err, newList) => {
                t.error(err, 'no error')

                t.deepEqual(
                  newList,
                  list,
                  'list returns save results after restart'
                )
                server.close(true, t.end)
              })
            )
          })
        })
      })
    )
  })
})

test('get', async (t) => {
  const ssb = Testbot()

  const { id, writeKey, readKeys, root } = await ssb.tribes2
    .create()
    .catch(t.error)

  const group = await ssb.tribes2.get(id)

  t.equal(id, group.id)
  t.true(isIdentityGroupSSBURI(group.id))
  t.true(Buffer.isBuffer(group.writeKey.key), 'writeKey has key buffer')
  t.equal(writeKey.key, group.writeKey.key)
  t.true(Buffer.isBuffer(group.readKeys[0].key))
  t.equal(readKeys[0].key, group.readKeys[0].key)
  t.true(isClassicMessageSSBURI(group.root), 'has root')
  t.equal(root, group.root)

  await p(ssb.close)(true)
})

test('list', (t) => {
  const ssb = Testbot()

  ssb.tribes2
    .create()
    .then(({ id: id1, writeKey: writeKey1 }) => {
      t.true(isIdentityGroupSSBURI(id1), 'has id')

      pull(
        ssb.tribes2.list(),
        pull.collect(async (err, groups1) => {
          t.error(err, 'no error')

          t.equal(groups1.length, 1, 'lists the 1 group')

          const { id: id2 } = await ssb.tribes2.create().catch(t.error)

          pull(
            ssb.tribes2.list(),
            pull.collect(async (err, groups2) => {
              t.error(err, 'no error')

              t.equal(groups2.length, 2)
              t.equal(groups2[0].id, id1)
              t.equal(groups2[0].writeKey.key, writeKey1.key)
              t.equal(groups2[1].id, id2)

              ssb.close(true, t.end)
            })
          )
        })
      )
    })
    .catch(t.error)
})

test('live list groups', async (t) => {
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

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicated their trees')

  const groups = []
  pull(
    bob.tribes2.list({ live: true }),
    pull.drain(
      (group) => {
        groups.push(group)
      },
      (err) => {
        if (err) t.fail(err)
      }
    )
  )

  await p(setTimeout)(2000)
  t.deepEqual(groups, [], 'only alice in the group so far')

  const group = await p(alice.tribes2.create)(null).catch(t.fail)
  t.pass('alice created a group')

  await alice.tribes2
    .addMembers(group.id, [bobRoot.id])
    .catch((err) => t.fail(err))
  t.pass('bob was added')

  await replicate(alice, bob).catch(t.fail)
  t.pass('alice and bob replicated the invite')

  await bob.tribes2.acceptInvite(group.id).catch(t.fail)
  t.pass('bob accepted invite')

  await p(setTimeout)(2000)
  console.log('groups', JSON.stringify(groups, null, 2))
  t.equal(groups.length, 1, 'bob now finds the group in the group list')
  t.equal(groups[0].id, group.id, 'id matches')
  t.equal(groups[0].root, group.root, 'root matches')
  t.true(groups[0].writeKey.key.equals(group.writeKey.key), 'secret matches')

  await Promise.all([p(alice.close)(true), p(bob.close)(true)])
})
