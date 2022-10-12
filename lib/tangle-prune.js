// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const bipf = require('bipf')

/* eslint-disable camelcase */
// these variables are calculated in
// test/tangle-prune.test.js
// if these variables are out of date and
//   * smaller than supposed to: we'll prune a bit much, tangles will converge a bit slower
//   * bigger than supposed to: we'll prune less than we can. users might run into 'the message you want to publish is too big' more often
// but either way no catastrophe
const MAX_SIZE_16_recps = 5546
const MAX_SIZE_1_recps = 6041

module.exports = function tanglePrune(content) {
  const tangle = 'group'
  const maxSize =
    content.recps.length > 1 ? MAX_SIZE_16_recps : MAX_SIZE_1_recps
  if (getLength(content) <= maxSize) return content

  content.tangles[tangle].previous = content.tangles[tangle].previous.sort(() =>
    Math.random() < 0.5 ? -1 : +1
  )
  // we shuffle so that if multiple peers are also trying to converge,
  // we hopefully tangle differently and converge faster

  while (
    content.tangles[tangle].previous.length &&
    getLength(content) > maxSize
  ) {
    content.tangles[tangle].previous.pop()
  }

  return content
}

function getLength(obj) {
  return bipf.encodingLength(obj)
}
