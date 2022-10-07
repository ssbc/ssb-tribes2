// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const pull = require('pull-stream')
const ssbKeys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('get added to a group', async (t) => {
  const alice = Testbot({ keys: ssbKeys.generate(null, 'alice') })
  const bob = Testbot({ keys: ssbKeys.generate(null, 'bob') })

  alice.tribes2.start()
  bob.tribes2.start()

  const {
    id: groupId,
    subfeed,
    secret,
    root,
  } = await alice.tribes2.create().catch(t.error)

  await alice.tribes2.addMembers(groupId, [bob.id])

  await replicate(alice, bob)

  await new Promise((res) =>
    pull(
      bob.tribes2.list(),
      pull.collect((err, bobList) => {
        t.equal(bobList.length, 1, 'bob is a member of a group now')
        const group = bobList[0]
        t.equal(group.id, groupId)
        //TODO: subfeed
        t.true(group.secret.equals(secret))
        t.equal(group.root, root)

        alice.close(true, () => bob.close(true, () => res()))
      })
    )
  )
})
