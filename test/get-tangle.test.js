// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const { promisify: p } = require('util')
const {
  author,
  or,
  descending,
  toPullStream,
  where,
} = require('ssb-db2/operators')

const GetTangle = require('../lib/get-tangle')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('get-tangle unit test', (t) => {
  const name = `get-group-tangle-${Date.now()}`
  const server = Testbot({ name })

  server.metafeeds.findOrCreate(
    { purpose: 'group/additions' },
    (err, additions) => {
      t.error(err, 'no error')

      server.tribes2.create(null, (err, group) => {
        t.error(err, 'no error')

        const getTangle = GetTangle(server, 'group')

        getTangle(group.id, async (err, groupTangle) => {
          t.error(err, 'no error')

          const { root, previous } = groupTangle
          const rootKey = group.root

          pull(
            server.db.query(
              where(or(author(group.subfeed.id), author(additions.id))),
              descending(),
              toPullStream()
            ),
            pull.map((m) => m.key),
            pull.take(1),
            pull.collect((err, keys) => {
              t.error(err, 'no error')

              t.deepEqual(
                { root, previous },
                { root: rootKey, previous: [keys[0]] },
                'group add-member of admin should be the tip'
              )

              //  publishing to the group:
              const content = {
                type: 'memo',
                root: rootKey,
                message: 'unneccessary',
                recps: [group.id],
              }

              server.tribes2.publish(content, (err, msg) => {
                t.error(err, 'no error')

                getTangle(group.id, (err, { root, previous }) => {
                  t.error(err, 'no error')
                  t.deepEqual(
                    { root, previous },
                    { root: rootKey, previous: [msg.key] },
                    'adding message to root'
                  )

                  server.tribes2.publish(content, (err, msg) => {
                    t.error(err, 'no error')

                    getTangle(group.id, (err, { root, previous }) => {
                      t.error(err, 'no error')
                      t.deepEqual(
                        { root, previous },
                        { root: rootKey, previous: [msg.key] },
                        'adding message to tip'
                      )
                      server.close(true, t.end)
                    })
                  })
                })
              })
            })
          )
        })
      })
    }
  )
})

const n = 100
test(`get-tangle-${n}-publishes`, (t) => {
  const publishArray = new Array(n).fill().map((item, i) => i)
  const server = Testbot()
  let count = 0
  server.tribes2.create(null, (err, data) => {
    t.error(err, 'no error creating group')

    const groupId = data.id
    pull(
      pull.values(publishArray),
      paraMap(
        (value, cb) =>
          server.tribes2.publish({ type: 'memo', value, recps: [groupId] }, cb),
        4
      ),
      paraMap((msg, cb) => server.db.getMsg(msg.key, cb), 10),
      pull.drain(
        (m) => {
          count += m.value.content.tangles.group.previous.length
        },
        (err) => {
          t.error(err, 'no error publishing')

          t.true(
            count < n * 8,
            'We expect bounded branching with fast publishing'
          )

          server.close(true, t.end)
        }
      )
    )
  })
})

test('get-tangle', (t) => {
  // this is an integration test, as get-group-tangle is used in ssb.tribes2.publish
  const ssb = Testbot()

  ssb.tribes2.create(null, (err, data) => {
    t.error(err, 'create group')

    const groupRoot = data.root
    const groupId = data.id

    const content = {
      type: 'yep',
      recps: [groupId],
    }

    ssb.db.onMsgAdded((lastMsgAfterCreate) => {
      ssb.tribes2.publish(content, (err, msg) => {
        t.error(err, 'publish a message')

        ssb.db.get(msg.key, (err, A) => {
          t.error(err, 'get that message back')

          t.deepEqual(
            A.content.tangles.group, // actual
            // last message is the admin adding themselves to the group they just created i.e. not the root msg
            { root: groupRoot, previous: [lastMsgAfterCreate.kvt.key] }, // expected
            'auto adds group tangle (auto added tangles.group)'
          )

          ssb.close(true, t.end)
        })
      })
    })
  })
})

test('get-tangle with branch', async (t) => {
  const alice = Testbot()
  alice.tribes2.start()

  const bob = Testbot()
  bob.tribes2.start()
  t.pass('started tribes2')

  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicated their trees')

  // Alice creates a group
  const group = await p(alice.tribes2.create)(null).catch(t.fail)
  t.pass('alice created a group')

  const getAliceGroupTangle = GetTangle(alice, 'group')
  const getBobGroupTangle = GetTangle(bob, 'group')

  const invite = await p(alice.tribes2.addMembers)(group.id, [bobRoot.id], {
    text: 'ahoy',
  }).catch(t.fail)
  t.pass('alice invited bob')

  // Alice shares the group creation and invite with Bob.
  await replicate(alice, bob)
  t.pass('alice and bob replicated their group feeds')

  await bob.tribes2.acceptInvite(group.id)

  // Both servers should see the same group tangle
  const aliceTangle = await p(getAliceGroupTangle)(group.id).catch(t.fail)
  const bobTangle = await p(getBobGroupTangle)(group.id).catch(t.fail)
  t.deepEqual(aliceTangle, bobTangle, 'tangles should match')
  t.deepEqual(aliceTangle.root, group.root, 'the root is the groupId')
  t.deepEqual(aliceTangle.previous, [invite.key], 'previous is the invite key')

  // Alice and Bob will both publish a message
  const content = () => ({
    type: 'memo',
    message: 'branch',
    recps: [group.id],
  })

  await p(alice.tribes2.publish)(content()).catch(t.fail)
  t.pass('alice published a message')

  await p(bob.tribes2.publish)(content()).catch(t.fail)
  t.pass('bob published a message')

  // Then Bob shares his message with Alice
  await replicate(bob, alice)
  t.pass('bob and alice replicated their trees')

  // There should now be a branch in Alice's group tangle
  const aliceTangle2 = await p(getAliceGroupTangle)(group.id).catch(t.fail)

  t.deepEqual(aliceTangle2.previous.length, 2, 'There should be two tips')

  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('members tangle works', async (t) => {
  const alice = Testbot()
  const bob = Testbot()
  const carol = Testbot()

  await alice.tribes2.start()
  await bob.tribes2.start()
  await carol.tribes2.start()

  const bobRoot = await p(bob.metafeeds.findOrCreate)()
  const carolRoot = await p(carol.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  await replicate(alice, carol)
  t.pass('alice, bob and carol replicated their trees')

  const group = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  const getGroup = GetTangle(alice, 'group')
  const getMembers = GetTangle(alice, 'members')

  const bobInvite = await p(alice.tribes2.addMembers)(group.id, [bobRoot.id], {
    text: 'ahoy',
  }).catch(t.fail)
  await replicate(alice, bob)
  await bob.tribes2.acceptInvite(group.id)
  const bobPost = await bob.tribes2.publish({
    type: 'post',
    text: 'hi',
    recps: [group.id],
  })
  await replicate(alice, bob)
  t.pass('bob joined group and posted')

  const groupTangle = await p(getGroup)(group.id)
  const membersTangle = await p(getMembers)(group.id)

  const expectedGroupTangle = { root: group.root, previous: [bobPost.key] }
  const expectedMembersTangle = { root: group.root, previous: [bobInvite.key] }
  t.deepEquals(groupTangle, expectedGroupTangle, 'group tangle is correct')
  t.deepEquals(
    membersTangle,
    expectedMembersTangle,
    'members tangle is correct'
  )

  const carolInviteEnc = await p(alice.tribes2.addMembers)(
    group.id,
    [carolRoot.id],
    {
      text: 'ahoyyy',
    }
  ).catch((err) => {
    console.error('failed to add carol', err)
    t.fail(err)
  })
  t.pass('added carol to group')

  const carolInvite = await p(alice.db.get)(carolInviteEnc.key)

  t.deepEquals(
    carolInvite.content.tangles,
    {
      group: expectedGroupTangle,
      members: expectedMembersTangle,
    },
    'tangle on msg is correct'
  )

  const newGroupTangle = await p(getGroup)(group.id)
  const newMembersTangle = await p(getMembers)(group.id)

  t.deepEquals(
    newGroupTangle,
    {
      root: group.root,
      previous: [carolInviteEnc.key],
    },
    'got correct updated group tangle'
  )
  t.deepEquals(
    newMembersTangle,
    {
      root: group.root,
      previous: [carolInviteEnc.key],
    },
    'got correct updated members tangle'
  )

  await p(alice.close)(true)
  await p(bob.close)(true)
  await p(carol.close)(true)
})
