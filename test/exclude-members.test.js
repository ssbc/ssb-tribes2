// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')
const countGroupFeeds = require('./helpers/count-group-feeds')

test('add and remove a person, post on the new feed', async (t) => {
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

  await alice.tribes2.start()
  await bob.tribes2.start()
  t.pass('tribes2 started for both alice and bob')

  await p(alice.metafeeds.findOrCreate)()
  const bobRoot = await p(bob.metafeeds.findOrCreate)()

  await replicate(alice, bob)
  t.pass('alice and bob replicate their trees')

  const { id: groupId } = await alice.tribes2.create().catch((err) => {
    console.error('alice failed to create group', err)
    t.fail(err)
  })
  t.pass('alice created a group')

  await alice.tribes2.addMembers(groupId, [bobRoot.id]).catch((err) => {
    console.error('add member fail', err)
    t.fail(err)
  })
  t.pass('alice added bob to the group')

  t.equals(
    await p(countGroupFeeds)(alice),
    1,
    'before exclude alice has 1 group feed'
  )

  await alice.tribes2.excludeMembers(groupId, [bobRoot.id]).catch((err) => {
    console.error('remove member fail', err)
    t.fail(err)
  })

  t.equals(
    await p(countGroupFeeds)(alice),
    2,
    'after exclude alice has 2 group feeds'
  )

  await alice.tribes2
    .publish({
      type: 'test',
      text: 'post',
      recps: [groupId],
    })
    .catch(t.fail)

  t.equals(
    await p(countGroupFeeds)(alice),
    2,
    'alice still has 2 group feeds after publishing on the new feed'
  )

  // TODO: verify that message was published on the new feed

  await p(alice.close)(true)
  await p(bob.close)(true)
})
