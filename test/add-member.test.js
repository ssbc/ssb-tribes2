// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const pull = require('pull-stream')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')

test('get added to a group', async (t) => {
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

  alice.tribes2.start()
  bob.tribes2.start()

  const {
    id: groupId,
    subfeed,
    secret,
    root,
  } = await alice.tribes2.create().catch(t.fail)

  await alice.tribes2.addMembers(groupId, [bob.id])

  await replicate(alice, bob, { waitUntilMembersOf: groupId })

  await new Promise((res) =>
    pull(
      bob.tribes2.list(),
      pull.collect((err, bobList) => {
        t.equal(bobList.length, 1, 'bob is a member of a group now')
        const group = bobList[0]
        t.equal(group.id, groupId)
        t.true(group.secret.equals(secret))
        t.equal(group.root, root)
        res()
      })
    )
  )

  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('add member', async (t) => {
  const kaitiaki = Testbot({
    keys: ssbKeys.generate(null, 'kaitiaki'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a11a',
      'hex'
    ),
  })
  const newPerson = Testbot({
    keys: ssbKeys.generate(null, 'bob'),
    mfSeed: Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000b0b',
      'hex'
    ),
  })
  kaitiaki.tribes2.start()
  newPerson.tribes2.start()

  try {
    const group = await kaitiaki.tribes2.create()
    t.true(group.id, 'creates group')

    const authorIds = [newPerson.id, ssbKeys.generate(null, 'carol').id]

    const encryptedInvite = await kaitiaki.tribes2.addMembers(
      group.id,
      authorIds,
      {
        text: 'welcome friends',
      }
    )

    const invite = await p(kaitiaki.db.get)(encryptedInvite.key)

    const expected = {
      type: 'group/add-member',
      version: 'v1',
      groupKey: group.secret.toString('base64'),
      root: group.root,

      text: 'welcome friends',
      recps: [group.id, ...authorIds],

      tangles: {
        group: {
          root: group.root,
          // we don't know the key of the last message, that was the admin adding themselves
          previous: invite.content.tangles.group.previous,
        },
        members: { root: group.root, previous: [group.root] },
      },
    }
    t.deepEqual(invite.content, expected, 'kaitiaki sent invite')

    /* kaitiaki posts to group, new person can read */
    const greetingContent = {
      type: 'post',
      text: 'Welcome new person!',
      recps: [group.id],
    }
    const { key: greetingKey } = await kaitiaki.tribes2.publish(greetingContent)
    await replicate(kaitiaki, newPerson)
    const greetingMsg = await p(newPerson.db.getMsg)(greetingKey)
    t.deepEqual(
      greetingMsg.value.content,
      greetingContent,
      'new person can read group content'
    )

    /* new person posts to group, kaitiaki can read */
    const replyContent = {
      type: 'post',
      text: 'Thank you kaitiaki',
      recps: [group.id],
    }
    const { key: replyKey } = await newPerson.tribes2.publish(replyContent)
    await replicate(newPerson, kaitiaki)
    const replyMsg = await p(kaitiaki.db.getMsg)(replyKey)
    t.deepEqual(
      replyMsg.value.content,
      replyContent,
      'kaitiaki can read things from new person'
    )
  } catch (err) {
    t.fail(err)
  }

  await new Promise((resolve) => {
    kaitiaki.close(true, () => newPerson.close(true, resolve))
  })
})
