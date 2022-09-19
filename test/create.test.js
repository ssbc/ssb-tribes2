// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const ref = require('ssb-ref')
const Testbot = require('./testbot')

test('create', async t => {
  const ssb = Testbot()

  const { id, subfeed, secret, root } = await ssb.tribes2.create()

  t.true(ref.isCloakedMsgId(id), 'has groupId')
  t.true(subfeed && ref.isFeed(subfeed.id), 'has keys')
  t.true(Buffer.isBuffer(secret), 'has secret')
  t.true(root && ref.isFeed(subfeed.root), 'has root')

  // ...

  ssb.close()
  t.end()
})
