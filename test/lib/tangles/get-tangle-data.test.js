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
const { fromMessageSigil } = require('ssb-uri2')

const getTangle = require('../../../lib/tangles/get-tangle-data')
const Testbot = require('../../helpers/testbot')
const replicate = require('../../helpers/replicate')

test('get-tangle-data unit test', (t) => {
  const server = Testbot()

  server.metafeeds.findOrCreate(
    { purpose: 'group/additions' },
    (err, additions) => {
      t.error(err, 'no error')

      server.tribes2.create(null, (err, group) => {
        t.error(err, 'no error')

        getTangle(server, 'group', group.id, async (err, groupTangle) => {
          t.error(err, 'no error')

          const { root, previous } = groupTangle
          const rootKey = group.root

          pull(
            server.db.query(
              where(or(author(group.subfeed.id), author(additions.id))),
              descending(),
              toPullStream()
            ),
            pull.map((m) => fromMessageSigil(m.key)),
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

              server.tribes2.publish(content, null, (err, msg) => {
                t.error(err, 'no error')

                getTangle(
                  server,
                  'group',
                  group.id,
                  (err, { root, previous }) => {
                    t.error(err, 'no error')
                    t.deepEqual(
                      { root, previous },
                      { root: rootKey, previous: [fromMessageSigil(msg.key)] },
                      'adding message to root'
                    )

                    server.tribes2.publish(content, null, (err, msg) => {
                      t.error(err, 'no error')

                      getTangle(
                        server,
                        'group',
                        group.id,
                        (err, { root, previous }) => {
                          t.error(err, 'no error')
                          t.deepEqual(
                            { root, previous },
                            {
                              root: rootKey,
                              previous: [fromMessageSigil(msg.key)],
                            },
                            'adding message to tip'
                          )
                          server.close(true, () => t.end())
                        }
                      )
                    })
                  }
                )
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

    //console.time('getTangles')

    pull(
      pull.values(publishArray),
      paraMap(
        (value, cb) =>
          server.tribes2.publish(
            { type: 'memo', value, recps: [groupId] },
            { tangles: ['members', 'epoch'] },
            cb
          ),
        4
      ),
      paraMap((msg, cb) => server.db.getMsg(msg.key, cb), 10),
      pull.drain(
        (m) => {
          count += m.value.content.tangles.group.previous.length
        },
        (err) => {
          t.error(err, 'no error publishing')

          //console.timeEnd('getTangles')

          t.true(
            count < n * 8,
            'We expect bounded branching with fast publishing'
          )

          server.close(true, () => t.end())
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
      ssb.tribes2.publish(content, null, (err, msg) => {
        t.error(err, 'publish a message')

        ssb.db.get(msg.key, (err, A) => {
          t.error(err, 'get that message back')

          t.deepEqual(
            A.content.tangles.group, // actual
            // last message is the admin adding themselves to the group they just created i.e. not the root msg
            {
              root: groupRoot,
              previous: [fromMessageSigil(lastMsgAfterCreate.kvt.key)],
            }, // expected
            'auto adds group tangle (auto added tangles.group)'
          )

          ssb.close(true, () => t.end())
        })
      })
    })
  })
})

test('get-tangle with branch', async (t) => {
  const alice = Testbot()
  const bob = Testbot()
  await Promise.all([alice.tribes2.start(), bob.tribes2.start()])
  t.pass('started tribes2')

  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicated their trees')

  // Alice creates a group
  const group = await p(alice.tribes2.create)(null).catch(t.fail)
  t.pass('alice created a group')

  const [invite] = await p(alice.tribes2.addMembers)(group.id, [bobRoot.id], {
    text: 'ahoy',
  }).catch(t.fail)
  t.pass('alice invited bob')

  // Alice shares the group creation and invite with Bob.
  await replicate(alice, bob)
  t.pass('alice and bob replicated their group feeds')

  await bob.tribes2.acceptInvite(group.id)

  // Both servers should see the same group tangle
  const aliceTangle = await p(getTangle)(alice, 'group', group.id).catch(t.fail)
  const bobTangle = await p(getTangle)(bob, 'group', group.id).catch(t.fail)
  t.deepEqual(aliceTangle, bobTangle, 'tangles should match')
  t.deepEqual(aliceTangle.root, group.root, 'the root is the groupId')
  t.deepEqual(
    aliceTangle.previous,
    [fromMessageSigil(invite.key)],
    'previous is the invite key'
  )

  // Alice and Bob will both publish a message
  const content = () => ({
    type: 'memo',
    message: 'branch',
    recps: [group.id],
  })

  await alice.tribes2.publish(content()).catch(t.fail)
  t.pass('alice published a message')

  await bob.tribes2.publish(content()).catch(t.fail)
  t.pass('bob published a message')

  // Then Bob shares his message with Alice
  await replicate(bob, alice)
  t.pass('bob and alice replicated their trees')

  // There should now be a branch in Alice's group tangle
  const aliceTangle2 = await p(getTangle)(alice, 'group', group.id).catch(
    t.fail
  )

  t.deepEqual(aliceTangle2.previous.length, 2, 'There should be two tips')

  await Promise.all([p(alice.close)(true), p(bob.close)(true)])
  t.end()
})

test('members tangle works', async (t) => {
  const alice = Testbot()
  const bob = Testbot()
  const carol = Testbot()

  await Promise.all([
    alice.tribes2.start(),
    bob.tribes2.start(),
    carol.tribes2.start(),
  ])

  const [bobRoot, carolRoot] = await Promise.all([
    p(bob.metafeeds.findOrCreate)(),
    p(carol.metafeeds.findOrCreate)(),
  ])

  await replicate(alice, bob)
  await replicate(alice, carol)
  t.pass('alice, bob and carol replicated their trees')

  const group = await alice.tribes2.create().catch(t.fail)
  t.pass('alice created a group')

  const [bobInvite] = await p(alice.tribes2.addMembers)(
    group.id,
    [bobRoot.id],
    {
      text: 'ahoy',
    }
  ).catch(t.fail)
  await replicate(alice, bob)
  await bob.tribes2.acceptInvite(group.id)
  const bobPost = await bob.tribes2.publish({
    type: 'post',
    text: 'hi',
    recps: [group.id],
  })
  await replicate(alice, bob)
  t.pass('bob joined group and posted')

  const groupTangle = await p(getTangle)(alice, 'group', group.id)
  const membersTangle = await p(getTangle)(alice, 'members', group.id)

  const expectedGroupTangle = {
    root: group.root,
    previous: [fromMessageSigil(bobPost.key)],
  }
  const expectedMembersTangle = {
    root: group.root,
    previous: [fromMessageSigil(bobInvite.key)],
  }
  t.deepEquals(groupTangle, expectedGroupTangle, 'group tangle is correct')
  t.deepEquals(
    membersTangle,
    expectedMembersTangle,
    'members tangle is correct'
  )

  const [carolInviteEnc] = await p(alice.tribes2.addMembers)(
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

  const newGroupTangle = await p(getTangle)(alice, 'group', group.id)
  const newMembersTangle = await p(getTangle)(alice, 'members', group.id)

  t.deepEquals(
    newGroupTangle,
    {
      root: group.root,
      previous: [fromMessageSigil(carolInviteEnc.key)],
    },
    'got correct updated group tangle'
  )
  t.deepEquals(
    newMembersTangle,
    {
      root: group.root,
      previous: [fromMessageSigil(carolInviteEnc.key)],
    },
    'got correct updated members tangle'
  )

  await Promise.all([
    p(alice.close)(true),
    p(bob.close)(true),
    p(carol.close)(true),
  ])
  t.end()
})
