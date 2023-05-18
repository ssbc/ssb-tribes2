// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const ssbKeys = require('ssb-keys')
const { promisify: p } = require('util')
const Testbot = require('./helpers/testbot')
const prunePublish = require('../lib/prune-publish')

test('prune a message with way too big `previous`', async (t) => {
  const ssb = Testbot({
    keys: ssbKeys.generate(null, 'alice'),
    mfSeed: Buffer.from(
      '000000000000000000000000000000000000000000000000000000000000a1ce',
      'hex'
    ),
  })

  await ssb.tribes2.start()

  const root = await p(ssb.metafeeds.findOrCreate)()

  const group = await p(ssb.tribes2.create)(null).catch(t.fail)

  const msgId = '%RDORgMCjmL6vs51nR4bn0LWNe6wkBfbRJulSdOJsmwg=.sha256'
  const content = (prevCount, numRecps) => ({
    type: 'post',
    text: 'hello!',
    recps: [group.id, ...Array(numRecps - 1).fill(root.id)],
    tangles: {
      group: {
        root: msgId,
        previous: new Array(prevCount).fill(msgId),
      },
    },
  })

  //console.time('prune')
  const encMsg16 = await p(prunePublish)(
    ssb,
    content(4000, 16),
    group.subfeed
  ).catch(t.fail)
  //console.timeEnd('prune')

  const msg16 = await p(ssb.db.get)(encMsg16.key).catch(t.fail)

  const msg16len = msg16.content.tangles.group.previous.length

  t.true(
    msg16len < 4000,
    `pruned ${4000 - msg16len} from 'previous', ${msg16len} remaining`
  )

  t.true(msg16len > 10, 'there are some previouses left')

  await p(ssb.close)(true)
  t.end()
})

test('publish many messages that might need pruning', async (t) => {
  const n = 5000
  const ssb = Testbot()

  const group = await p(ssb.tribes2.create)(null)

  const start = Date.now()
  let count = 0
  await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const content = { type: 'potato', count: i, recps: [group.id] }
      return ssb.tribes2.publish(content, null).then(() => {
        count++
        if (count % 1000 === 0) t.pass(count)
      })
    })
  )
    .then(() => {
      t.pass(`published ${n} messages in ${Date.now() - start}ms`)
    })
    .catch(t.error)

  await p(setTimeout)(1000)
  await p(ssb.close)(true)

  t.end()
})
