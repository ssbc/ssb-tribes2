// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { allocAndEncode, seekKey2, iterate } = require('bipf')
const { equal } = require('jitdb/operators')

const B_VALUE = allocAndEncode('value')
const B_CONTENT = allocAndEncode('content')
const B_TANGLES = allocAndEncode('tangles')
const B_ROOT = allocAndEncode('root')
const B_RECPS = allocAndEncode('recps')

const B_TANGLE_MAP = new Map()
// tangle: StrinG => B_TANGLE: Buffer

module.exports = {
  tangleRoot(tangle, value) {
    if (!B_TANGLE_MAP.has(tangle)) {
      B_TANGLE_MAP.set(tangle, allocAndEncode(tangle))
    }
    const B_TANGLE = B_TANGLE_MAP.get(tangle)

    function seekTangleRoot(buffer, start, p) {
      if (p < 0) return -1
      p = seekKey2(buffer, 0, B_VALUE, 0)
      if (p < 0) return -1
      p = seekKey2(buffer, p, B_CONTENT, 0)
      if (p < 0) return -1
      p = seekKey2(buffer, p, B_TANGLES, 0)
      if (p < 0) return -1
      p = seekKey2(buffer, p, B_TANGLE, 0)
      if (p < 0) return -1
      return seekKey2(buffer, p, B_ROOT, 0)
    }

    return equal(seekTangleRoot, value, {
      indexType: `value_content_tangles_${tangle}_root`,
    })
  },

  groupRecp(value) {
    return equal(seekFirstRecp, value, {
      prefix: 32,
      indexType: 'value_content_recps_0',
    })
  },
}

function seekFirstRecp(buffer, start, p) {
  if (p < 0) return -1
  p = seekKey2(buffer, p, B_CONTENT, 0)
  if (p < 0) return -1
  p = seekKey2(buffer, p, B_RECPS, 0)
  if (p < 0) return -1

  let pValueFirstRecp
  const error = iterate(buffer, p, (_, pointer) => {
    pValueFirstRecp = pointer
    return true
  })
  if (error === -1) return -1
  return pValueFirstRecp
}
