// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')

const { tangleRoot } = require('../../lib/operators')

function getTangleUpdates(ssb, tangle, root, cb) {
  pull(tangleUpdateStream(ssb, tangle, root), pull.collect(cb))
}
getTangleUpdates.stream = tangleUpdateStream
module.exports = getTangleUpdates

function tangleUpdateStream(ssb, tangle, root) {
  const { where, and, toPullStream } = ssb.db.operators

  return pull(
    ssb.db.query(where(tangleRoot(tangle, root)), toPullStream()),
    pull.filter(
      (m) =>
        Array.isArray(m.value.content.tangles[tangle].previous) &&
        m.value.content.tangles[tangle].previous.length > 0
    )
  )
}
