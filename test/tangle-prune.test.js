// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
//const bipf = require('bipf')
const Testbot = require('./helpers/testbot')
const prunePublish = require('../lib/prune-publish')

//const chars = 'abcABC123=+? '.split('')
//const encodedLength = (obj) => bipf.encodingLength(obj)
//const randomChar = () => chars.sort(() => (Math.random() < 0.5 ? -1 : +1))[0]
//const randomText = (length) => {
//  let output = ''
//  while (output.length < length) output += randomChar()
//  return output
//}

test('prune a message with way too big `previous`', (t) => {
  const ssb = Testbot()
  const ssbId = ssb.id

  ssb.tribes2.create(null, (err, group) => {
    t.error(err, 'no err on group create')

    const msgId = '%RDORgMCjmL6vs51nR4bn0LWNe6wkBfbRJulSdOJsmwg=.sha256'
    const content = (prevCount, numRecps) => ({
      type: 'post',
      text: 'hello!',
      recps: [group.id, new Array(numRecps - 1).fill(ssbId)],
      tangles: {
        group: {
          root: msgId,
          previous: new Array(prevCount).fill(msgId),
        },
      },
    })

    //console.time('prune')
    prunePublish(ssb, content(4000, 16), (err, encMsg16) => {
      //console.timeEnd('prune')
      ssb.db.get(encMsg16.key, (err, msg16) => {
        const msg16len = msg16.content.tangles.group.previous.length

        t.true(
          msg16len < 4000,
          `pruned ${4000 - msg16len} from 'previous', ${msg16len} remaining`
        )

        t.true(msg16len > 10, 'there are some previouses left')

        ssb.close(true, t.end)
      })
    })
  })
})

test('publish many messages that might need pruning', (t) => {
  const n = 5000
  const ssb = Testbot()

  const publishArray = new Array(n).fill().map((item, i) => i)

  ssb.tribes2.create(null, (err, group) => {
    const publishes = publishArray.map(
      (value) =>
        new Promise((res, rej) => {
          ssb.tribes2.publish(
            { type: 'potato', content: value, recps: [group.id] },
            (err, msg) => {
              if (err) return rej(err)
              return res(msg)
            }
          )
        })
    )

    //console.time('publish')
    Promise.all(publishes)
      .then(async (msgs) => {
        //console.timeEnd('publish')

        ssb.close(true, t.end)
      })
      .catch(t.error)
  })
})
