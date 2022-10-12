// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const { promisify: p } = require('util')
const bipf = require('bipf')
const Testbot = require('./helpers/testbot')
const tanglePrune = require('../lib/tangle-prune')

const chars = 'abcABC123=+? '.split('')
//const encodedLength = (obj) => JSON.stringify(msgVal.content).length
const encodedLength = (obj) => bipf.encodingLength(obj)
const randomChar = () => chars.sort(() => (Math.random() < 0.5 ? -1 : +1))[0]
const randomText = (length) => {
  let output = ''
  while (output.length < length) output += randomChar()
  return output
}

test.only('tangle prune', async (t) => {
  const ssb = Testbot()
  const ssbId = ssb.id

  const group = await ssb.tribes2.create()

  const publishSize = async (size, recpCount = 1) => {
    const content = {
      type: 'post',
      text: randomText(size),
      recps: [group.id, ...new Array(recpCount - 1).fill(ssbId)],
    }

    return new Promise((resolve, reject) => {
      ssb.tribes2.publish(content, (err, msg) => {
        if (err) return resolve(false)

        ssb.db.get(msg.key, (err, msgVal) => {
          if (err) return reject(err)
          const plainLength = encodedLength(msgVal.content)
          resolve(plainLength)
        })
      })
    })
  }

  async function findMaxSize(numberRecps = 1) {
    // Apply bisection method to find max size of a message which can be published

    let lower = 4000
    let mid
    let upper = 8000

    const results = new Map([])

    //let i = 0
    while (upper - lower > 1) {
      mid = Math.ceil((lower + upper) / 2)

      if (!results.has(lower)) {
        const res =
          results.get(lower) || (await publishSize(lower, numberRecps))
        results.set(lower, res)
      }

      if (!results.has(mid)) {
        const res = results.get(mid) || (await publishSize(mid, numberRecps))
        results.set(mid, res)
      }
      if (!results.has(upper)) {
        const res =
          results.get(upper) || (await publishSize(upper, numberRecps))
        results.set(upper, res)
      }

      //console.log(i++, {
      //  [lower]: results.get(lower),
      //  [mid]: results.get(mid),
      //  [upper]: results.get(upper),
      //})

      if (Boolean(results.get(lower)) !== Boolean(results.get(mid))) upper = mid
      else if (Boolean(results.get(mid)) !== Boolean(results.get(upper)))
        lower = mid
      else throw new Error('bisection fail')
    }

    const result = results.get(upper) || results.get(mid) || results.get(lower)
    t.pass(`max stringied content size for ${numberRecps} recps:  ${result}`)
  }
  const max16recps = await findMaxSize(16).catch(t.error) // 5546
  const max1recp = await findMaxSize(1).catch(t.error) // 6041
  ssb.close()

  const msgId = '%RDORgMCjmL6vs51nR4bn0LWNe6wkBfbRJulSdOJsmwg=.sha256'
  const content = (prevCount, numRecps) => ({
    type: 'post',
    text: 'hello!',
    recps: [...new Array(numRecps).fill(ssbId)],
    tangles: {
      group: {
        root: msgId,
        previous: new Array(prevCount).fill(msgId),
      },
    },
  })

  // console.time('prune')
  const result16 = tanglePrune(content(4000, 16), 'group')
  // console.timeEnd('prune')
  t.true(
    encodedLength(result16) <= max16recps,
    `pruned ${4000 - result16.tangles.group.previous.length}`
  )

  const result1 = tanglePrune(content(4000, 1))
  t.true(
    encodedLength(result1) <= max1recp,
    `pruned ${4000 - result1.tangles.group.previous.length}`
  )

  t.end()
})
