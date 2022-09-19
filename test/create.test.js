// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const ref = require('ssb-ref')
const Testbot = require('./testbot')
const { promisify: p} = require('util')

test('create', async t => {
  const ssb = Testbot()

  const { id, subfeed, secret, root } = await ssb.tribes2.create()
    .catch(t.error)

  t.true(ref.isCloakedMsgId(id), 'has id')
  t.true(Buffer.isBuffer(secret), 'has secret')
  t.true(ref.isMsg(root), 'has root')
  //TODO
  //t.true(subfeed && ref.isFeed(subfeed.id), 'has subfeed')

  const content = {
    type: 'post',
    text: 'hello this is test',
    recps: [id],
  }

  const msg = await p(ssb.db.create)({
    content,
    //keys: subfeed.keys,
    encryptionFormat: 'box2',
  })
    .catch(t.error)

  t.equal(typeof msg.value.content, 'string')
  //t.equal(msg.value.author, subfeed.id)
  t.equal(msg.value.sequence, 2)

  console.log('msg', msg)

  ssb.close()
  t.end()
})

