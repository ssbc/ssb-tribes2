// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const pull = require('pull-stream')
const paraMap = require('pull-paramap')
const {
  and,
  type,
  author,
  paginate,
  descending,
  toCallback,
  toPullStream,
  where,
} = require('ssb-db2/operators')

const GetGroupTangle = require('../lib/get-group-tangle')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('get-group-tangle unit test', (t) => {
  const name = `get-group-tangle-${Date.now()}`
  const server = Testbot({ name })

  server.tribes2.create(null, (err, group) => {
    if (err) throw err

    // NOTE: Publishing has a queue which means if you publish many things in a row there is a delay before those values are in indexes to be queried.
    const _getGroupTangle = GetGroupTangle(server)
    const getGroupTangle = (id, cb) => {
      setTimeout(() => _getGroupTangle(id, cb), 300)
    }

    getGroupTangle(group.id, (err, groupTangle) => {
      if (err) throw err

      const { root, previous } = groupTangle
      const rootKey = group.root

      pull(
        server.db.query(where(author(server.id)), descending(), toPullStream()),
        pull.map((m) => m.key),
        pull.take(1),
        pull.collect((err, keys) => {
          if (err) throw err

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
            if (err) throw err

            getGroupTangle(group.id, (err, { root, previous }) => {
              if (err) throw err
              t.deepEqual(
                { root, previous },
                { root: rootKey, previous: [msg.key] },
                'adding message to root'
              )

              server.tribes2.publish(content, (err, msg) => {
                if (err) throw err

                getGroupTangle(group.id, (err, { root, previous }) => {
                  if (err) throw err
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
    if (err) throw err

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
    if (err) throw err

    const DELAY = 200
    const _getAliceGroupTangle = GetGroupTangle(alice)
    const getAliceGroupTangle = (id, cb) => {
      setTimeout(() => _getAliceGroupTangle(id, cb), DELAY)
    }
    const _getBobGroupTangle = GetGroupTangle(bob)
    const getBobGroupTangle = (id, cb) => {
      setTimeout(() => _getBobGroupTangle(id, cb), DELAY)
    }

    // Alice invites Bob to the group
    const aliceAddMembers = (...args) => {
      // slow this step down so the group tangle cache has time to be update
      // and be linear
      setTimeout(() => alice.tribes2.addMembers(...args), DELAY)
    }

    aliceAddMembers(
      group.id,
      [bob.id],
      { text: 'ahoy' },
      async (err, invite) => {
        t.error(err, 'alice adds bob to group') // Not actually an error?

        // Alice shares the group creation and invite with Bob.
        await replicate(alice, bob)

        // Both servers should see the same group tangle
        getAliceGroupTangle(group.id, (err, aliceTangle) => {
          if (err) throw err
          getBobGroupTangle(group.id, (err, bobTangle) => {
            if (err) throw err
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

            alice.tribes2.publish(content(), (err, msg) => {
              t.error(err, 'alice publishes a new message')

              // NOTE With the content.recps we are adding we might be asking Bob to know about a group before he's
              // found out about it for himself
              whenBobHasGroup(group.id, () => {
                bob.tribes2.publish(content(), async (err, msg) => {
                  if (err) throw err
                  // Then Bob shares his message with Alice
                  await replicate(bob, alice)
                  // There should now be a branch in Alice's group tangle
                  getAliceGroupTangle(group.id, (err, aliceTangle) => {
                    if (err) throw err

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
        })
      }
    )
  })

  function whenBobHasGroup(groupId, fn) {
    bob.tribes2.get(groupId, (err, data) => {
      if (err) {
        setTimeout(() => {
          console.log('waiting for bob...')
          whenBobHasGroup(groupId, fn)
        }, 100)
      } else fn()
    })
  }
})
