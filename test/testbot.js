// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const Bot = require('scuttle-testbot')

module.exports = function Testbot(opts = {}) {
  const stack = Bot
    // NOTE: these already already in scuttlebot
    // .use(require('ssb-db2'))
    // .use(require('ssb-box2'))
    .use(require('ssb-db2/compat/feedstate'))
    .use(require('../'))

  return stack({
    // path,                (app data location)
    // keys,                (see ssb-keys)
    // startUnclean: false, (clean = rimraf path)
    db2: true,
    ...opts,
  })
}
