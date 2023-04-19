// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { allocAndEncode, seekKey2, iterate } = require('bipf')
const { equal } = require('jitdb/operators')

const B_CONTENT = allocAndEncode('content')
const B_TANGLES = allocAndEncode('tangles')
const B_ROOT = allocAndEncode('root')
const B_RECPS = allocAndEncode('recps')

function seekFirstRecp (buffer, start, pValue) {
  if (pValue < 0) return -1
  const pValueContent = seekKey2(buffer, pValue, B_CONTENT, 0)
  if (pValueContent < 0) return -1
  const pValueRecps = seekKey2(buffer, pValueContent, B_RECPS, 0)
  if (pValueRecps < 0) return -1

  let pValueFirstRecp
  const error = iterate(buffer, pValueRecps, (_, pointer, key) => {
    pValueFirstRecp = pointer
    return true
  })
  if (error === -1) return -1
  return pValueFirstRecp
}

const B_TANGLE_MAP = new Map()
// tangle: StrinG => B_TANGLE: Buffer

function SeekTangleRoot (tangle) {
  if (!B_TANGLE_MAP.has(tangle)) {
    B_TANGLE_MAP.set(tangle, allocAndEncode(tangle))
  }

  const B_TANGLE = B_TANGLE_MAP.get(tangle)

  return function seekTangleRoot (buffer, start, p) {
    if (p < 0) return -1
    p = seekKey2(buffer, p, B_CONTENT, 0)
    if (p < 0) return -1
    p = seekKey2(buffer, p, B_TANGLES, 0)
    if (p < 0) return -1
    p = seekKey2(buffer, p, B_TANGLE, 0)
    if (p < 0) return -1
    return seekKey2(buffer, p, B_ROOT, 0)
  }
}

module.exports = {
  tangleRoot(tangle, value) {
    const seekTangleRoot = SeekTangleRoot(tangle)
    return equal(seekTangleRoot, value, {
      prefix: 32,
      indexType: `value.content.tangles.${tangle}.root`,
    })
  },

  groupRecp(value) {
    return equal(seekFirstRecp, value, {
      prefix: 32,
      indexType: 'value_content_recps_0',
    })
  }
}
