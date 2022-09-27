// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const ref = require('ssb-ref')
const Testbot = require('./testbot')
const { promisify: p } = require('util')

test('get added to a group', async (t) => {
  const alice = Testbot()
  const bob = Testbot()

  const {
    id: groupId,
    subfeed,
    secret,
    root,
  } = await alice.tribes2.create().catch(t.error)

  alice.tribes2.addMembers(groupId, [bob.id])

  //TODO: replicate??
  //TODO: check that bob is a member

  alice.close()
  bob.close()
  t.end()
})
