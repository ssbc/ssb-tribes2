// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { isCloakedMsg } = require('ssb-ref')
const set = require('lodash.set')

//const getGroupTangle = GetGroupTangle(ssb, keystore)

//ssb.publish.hook(function (publish, args) {
module.exports = function addGroupTangle(content, cb) {
  //TODO: actually make this function work
  return cb(null, content)

  if (!content.recps) return cb(null, content)

  if (!isCloakedMsg(content.recps[0])) return cb(null, content)

  onKeystoreReady(() => {
    getGroupTangle(content.recps[0], (err, tangle) => {
      // NOTE there are two ways an err can occur in getGroupTangle
      // 1. recps is not a groupId
      // 2. unknown groupId,

      // Rather than cb(err) here we we pass it on to boxers to see if an err is needed
      if (err) return cb(null, content)

      set(content, 'tangles.group', tangle)
      //tanglePrune(content) // prune the group tangle down if needed

      cb(null, content)
    })
  })
}

/* eslint-disable camelcase */
const MAX_SIZE_16_recps = 5320
const MAX_SIZE_1_recps = 5800

function tanglePrune(content, tangle = 'group', maxSize) {
  maxSize =
    maxSize || (content.recps > 1 ? MAX_SIZE_16_recps : MAX_SIZE_1_recps)
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
  return JSON.stringify(obj).length
}
