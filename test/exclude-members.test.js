// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { promisify: p } = require('util')
const ssbKeys = require('ssb-keys')
const {
  where,
  and,
  count,
  isDecrypted,
  type,
  author,
  toCallback,
  toPullStream,
  toPromise,
} = require('ssb-db2/operators')
const pull = require('pull-stream')
const Testbot = require('./helpers/testbot')
const replicate = require('./helpers/replicate')
const countGroupFeeds = require('./helpers/count-group-feeds')

test('add and remove a person, post on the new feed', async (t) => {
  // feeds should look like
  // first: initGroup->excludeBob->reAddAlice
  // second: initEpoch->post
  // additions: addAlice->addBob (not checking this here)
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

  const {
    id: groupId,
    writeKey: writeKey1,
    subfeed: { id: firstFeedId },
  } = await alice.tribes2.create().catch((err) => {
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

  const {
    value: { author: secondFeedId },
  } = await alice.tribes2
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

  t.notEquals(
    secondFeedId,
    firstFeedId,
    'feed for publish is different to initial feed'
  )

  const { writeKey: writeKey2 } = await alice.tribes2.get(groupId)

  t.false(writeKey1.key.equals(writeKey2.key), "there's a new key for writing")

  const msgsFromFirst = await alice.db.query(
    where(author(firstFeedId)),
    toPromise()
  )

  const firstContents = msgsFromFirst.map((msg) => msg.value.content)

  t.equal(firstContents.length, 3, '3 messages on first feed')

  const firstInit = firstContents[0]

  t.equal(firstInit.type, 'group/init')
  t.equal(firstInit.groupKey, writeKey1.key.toString('base64'))

  //const excludeMsg = firstContents[1]

  // TODO: test excludeMsg once we use the correct format

  //const reinviteMsg = firstContents[2]

  // TODO: test reinviteMsg once we use the correct format (add-member)

  const msgsFromSecond = await alice.db.query(
    where(author(secondFeedId)),
    toPromise()
  )

  const secondContents = msgsFromSecond.map((msg) => msg.value.content)

  t.equal(secondContents.length, 2, '2 messages on second (new) feed')

  const secondInit = secondContents[0]

  t.equal(secondInit.type, 'group/init')
  t.equal(secondInit.version, 'v2')
  t.equal(secondInit.groupKey, writeKey2.key.toString('base64'))
  // TODO: test epoch tangle

  const post = secondContents[1]

  t.equal(post.text, 'post', 'found post on second feed')

  await p(alice.close)(true)
  await p(bob.close)(true)
})
