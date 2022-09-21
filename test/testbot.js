// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: Unlicense

const SecretStack = require('secret-stack')
const ssbKeys = require('ssb-keys')
const path = require('path')
const rimraf = require('rimraf')
const caps = require('ssb-caps')

let count = 0

// opts.path      (optional)
//   opts.name    (optional) - convenience method for deterministic opts.path
// opts.keys      (optional)
// opts.rimraf    (optional) - clear the directory before start (default: true)

module.exports = function createSbot(opts = {}) {
  const dir = opts.path || `/tmp/ssb-tribes2-tests-${opts.name || count++}`
  if (opts.rimraf !== false) rimraf.sync(dir)

  const keys = opts.keys || ssbKeys.loadOrCreateSync(path.join(dir, 'secret'))

  const stack = SecretStack({ appKey: caps.shs })
    .use(require('ssb-db2/core'))
    .use(require('ssb-classic'))
    // TODO: why do we need box1??
    .use(require('ssb-box'))
    .use(require('ssb-box2'))
    .use(require('ssb-db2/compat/feedstate'))
    .use(require('../'))

  return stack({
    path: dir,
    keys,
  })
}
