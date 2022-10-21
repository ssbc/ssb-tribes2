// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const { isCloakedMsg } = require('ssb-ref')
const set = require('lodash.set')
const GetGroupTangle = require('./get-group-tangle')

module.exports = function AddGroupTangle(server) {
  const getGroupTangle = GetGroupTangle(server)

  /**
   * Note that this mutates `content`
   */
  return function addGroupTangle(content, cb) {
    if (!content.recps) return cb(null, content)

    if (!isCloakedMsg(content.recps[0])) return cb(null, content)

    getGroupTangle(content.recps[0], (err, tangle) => {
      // NOTE there are two ways an err can occur in getGroupTangle
      // 1. recps is not a groupId
      // 2. unknown groupId,

      // Rather than cb(err) here we we pass it on to boxers to see if an err is needed
      if (err) return cb(null, content)

      set(content, 'tangles.group', tangle)

      // we shuffle so that if multiple peers are also trying to converge,
      // we hopefully tangle differently and converge faster (at least if some of the entries get pruned)
      content.tangles.group.previous = content.tangles.group.previous.sort(() =>
        Math.random() < 0.5 ? -1 : +1
      )

      cb(null, content)
    })
  }
}
