// SPDX-FileCopyrightText: 2023 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { allocAndEncode, seekKey2, iterate } = require('bipf')
const jitdbOperators = require('jitdb/operators')
const { equal } = jitdbOperators

const BIPF_CONTENT = allocAndEncode('content')
const BIPF_RECPS = allocAndEncode('recps')

function seekFirstRecp (buffer, start, pValue) {
  if (pValue < 0) return -1
  const pValueContent = seekKey2(buffer, pValue, BIPF_CONTENT, 0)
  if (pValueContent < 0) return -1
  const pValueRecps = seekKey2(buffer, pValueContent, BIPF_RECPS, 0)
  if (pValueRecps < 0) return -1

  let pValueFirstRecp
  const error = iterate(buffer, pValueRecps, (_, pointer, key) => {
    pValueFirstRecp = pointer
    return true
  })
  if (error === -1) return -1
  return pValueFirstRecp
}

module.exports = {
  isGroup(value) {
    return equal(seekFirstRecp, value, {
      prefix: 32,
      indexType: 'value_content_recps_0',
    })
  }
}
