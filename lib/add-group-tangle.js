// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const set = require('lodash.set')
const clarify = require('clarify-error')
const { isIdentityGroupSSBURI } = require('ssb-uri2')
const GetGroupTangle = require('./get-group-tangle')

module.exports = function AddGroupTangle(server) {
  const getGroupTangle = GetGroupTangle(server)

  /**
   * Note that this mutates `content`
   */
  return function addGroupTangle(content, cb) {
    if (!content.recps) return cb(null, content)

    if (!isIdentityGroupSSBURI(content.recps[0])) return cb(null, content)

    getGroupTangle(content.recps[0], (err, tangle) => {
      // prettier-ignore
      if (err) return cb(clarify(err, 'Failed to get group tangle when adding group tangle to message'))

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
