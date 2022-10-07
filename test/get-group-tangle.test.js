// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const { author, descending, toPullStream, where } = require('ssb-db2/operators')

const GetGroupTangle = require('../lib/get-group-tangle')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('get-group-tangle unit test', (t) => {
  const name = `get-group-tangle-${Date.now()}`
  const server = Testbot({ name })

  server.tribes2.create(null, (err, group) => {
    t.error(err, 'no error')

    const getGroupTangle = GetGroupTangle(server)

    getGroupTangle(group.id, (err, groupTangle) => {
      t.error(err, 'no error')

      const { root, previous } = groupTangle
      const rootKey = group.root

      pull(
        server.db.query(where(author(server.id)), descending(), toPullStream()),
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

            getGroupTangle(group.id, (err, { root, previous }) => {
              t.error(err, 'no error')
              t.deepEqual(
                { root, previous },
                { root: rootKey, previous: [msg.key] },
                'adding message to root'
              )

              server.tribes2.publish(content, (err, msg) => {
                t.error(err, 'no error')

                getGroupTangle(group.id, (err, { root, previous }) => {
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
})

const n = 100
test(`get-group-tangle-${n}-publishes`, (t) => {
  const publishArray = new Array(n).fill().map((item, i) => i)
  const server = Testbot()
  let count = 0
  server.tribes2.create(null, (err, data) => {
    t.error(err, 'no error')

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
          t.error(err, 'no error')

          // t.equal(count, n, 'We expect there to be no branches in our groupTangle')
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

test('get-group-tangle', (t) => {
  const tests = [
    {
      plan: 4,
      test: (t) => {
        const DESCRIPTION = 'auto adds group tangle'
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

          ssb.tribes2.publish(content, (err, msg) => {
            t.error(err, 'publish a message')

            ssb.db.get(msg.key, (err, A) => {
              t.error(err, 'get that message back')

              t.deepEqual(
                A.content.tangles.group, // actual
                { root: groupRoot, previous: [groupRoot] }, // expected
                DESCRIPTION + ' (auto added tangles.group)'
              )

              ssb.close()
            })
          })
        })
      },
    },
  ]

  const toRun = tests.reduce((acc, round) => {
    acc += round.plan || 1
    return acc
  }, 0)

  t.plan(toRun)

  tests.forEach((round) => round.test(t))
})

test('get-group-tangle with branch', (t) => {
  const alice = Testbot()
  alice.tribes2.start()
  const bob = Testbot()
  bob.tribes2.start()

  // Alice creates a group
  alice.tribes2.create(null, (err, group) => {
    t.error(err, 'no error')

    const getAliceGroupTangle = GetGroupTangle(alice)
    const getBobGroupTangle = GetGroupTangle(bob)

    alice.tribes2.addMembers(
      group.id,
      [bob.id],
      { text: 'ahoy' },
      async (err, invite) => {
        t.error(err, 'alice adds bob to group') // Not actually an error?

        // Alice shares the group creation and invite with Bob.
        await replicate(alice, bob)

        // Both servers should see the same group tangle
        getAliceGroupTangle(group.id, (err, aliceTangle) => {
          t.error(err, 'no error')
          getBobGroupTangle(group.id, (err, bobTangle) => {
            t.error(err, 'no error')
            t.deepEqual(aliceTangle, bobTangle, 'tangles should match')
            t.deepEqual(aliceTangle.root, group.root, 'the root is the groupId')
            t.deepEqual(
              aliceTangle.previous,
              [invite.key],
              'previous is the invite key'
            )

            // Alice and Bob will both publish a message
            const content = () => ({
              type: 'memo',
              message: 'branch',
              recps: [group.id],
            })

            alice.tribes2.publish(content(), (err) => {
              t.error(err, 'alice publishes a new message')

              bob.tribes2.publish(content(), async (err) => {
                t.error(err, 'no error')
                // Then Bob shares his message with Alice
                await replicate(bob, alice)
                // There should now be a branch in Alice's group tangle
                getAliceGroupTangle(group.id, (err, aliceTangle) => {
                  t.error(err, 'no error')

                  t.deepEqual(
                    aliceTangle.previous.length,
                    2,
                    'There should be two tips'
                  )
                  alice.close(true, () => bob.close(true, t.end))
                })
              })
            })
          })
        })
      }
    )
  })
})
