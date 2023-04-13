// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only
const pull = require('pull-stream')
const { seekKey } = require('bipf')

const B_VALUE = Buffer.from('value')
const B_CONTENT = Buffer.from('content')
const B_TANGLES = Buffer.from('tangles')
const B_ROOT = Buffer.from('root')

function getTangleUpdates(ssb, tangle, root, cb) {
  pull(
    tangleUpdateStream(ssb, tangle, root),
    pull.collect(cb)
  )
}
getTangleUpdates.stream = tangleUpdateStream
module.exports = getTangleUpdates

function tangleUpdateStream (ssb, tangle, root) {
  const B_TANGLE = Buffer.from(tangle)

  function tangleRoot(value) {
    return ssb.db.operators.equal(seekTangleRoot, value, {
      indexType: `value.content.tangles.${tangle}.root`,
    })
  }
  function seekTangleRoot(buffer) {
    let p = 0 // note you pass in p!
    p = seekKey(buffer, p, B_VALUE)
    if (p < 0) return
    p = seekKey(buffer, p, B_CONTENT)
    if (p < 0) return
    p = seekKey(buffer, p, B_TANGLES)
    if (p < 0) return
    p = seekKey(buffer, p, B_TANGLE)
    if (p < 0) return
    return seekKey(buffer, p, B_ROOT)
  }

  const { where, and, toPullStream } = ssb.db.operators

  return pull(
    ssb.db.query(where(and(tangleRoot(root))), toPullStream()),
    pull.filter(m => (
      Array.isArray(m.value.content.tangles[tangle].previous) &&
      m.value.content.tangles[tangle].previous.length > 0
    ))
  )
}
