// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const pull = require('pull-stream')

module.exports = function drainOne (handleRes, handleDone) {
  return pull(
    pull.take(1),
    pull.drain(
      handleRes,
      handleDone
    )
  )
}
