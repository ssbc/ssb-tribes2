// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: Unlicense

const SecretStack = require('secret-stack')
const ssbKeys = require('ssb-keys')
const bendyButtFormat = require('ssb-ebt/formats/bendy-butt')
const path = require('path')
const rimraf = require('rimraf')
const crypto = require('crypto')

const shs = crypto.randomBytes(32)
// ensure this is unique per run so peers can connect with one another but NOT
// the same as the main-net ssb-caps (so this doesn't try gossiping with e.g.
// manyverse instances)

let count = 0

/** opts.path    (optional)
 *  opts.name    (optional) - convenience method for deterministic opts.path
 *  opts.keys    (optional)
 *  opts.rimraf  (optional) - clear the directory before start (default: true)
 */
module.exports = function createSbot(opts = {}) {
  const dir = opts.path || `/tmp/ssb-tribes2-tests-${opts.name || count++}`
  if (opts.rimraf !== false) rimraf.sync(dir)

  const keys =
    opts.keys || opts.name
      ? ssbKeys.generate(null, opts.name)
      : ssbKeys.loadOrCreateSync(path.join(dir, 'secret'))

  const stack = SecretStack({ caps: { shs } })
    .use(require('ssb-db2/core'))
    .use(require('ssb-classic'))
    .use(require('ssb-bendy-butt'))
    .use(require('ssb-meta-feeds'))
    .use(require('ssb-box2'))
    .use(require('ssb-db2/compat/feedstate'))
    .use(require('ssb-db2/compat/ebt'))
    .use(require('ssb-db2/compat/db')) // for legacy replicate
    .use(require('ssb-db2/compat/history-stream')) // for legacy replicate
    .use(require('ssb-ebt'))
    .use(require('../..'))

  const sbot = stack({
    path: dir,
    keys,
    ebt: {
      // logging: true,
    },
    db2: opts.db2 || {
      flushDebounce: 10,
      writeTimeout: 10,
    },
    metafeeds: {
      seed: opts.mfSeed || mfSeedFromName(opts.name),
    },
    tribes2: {
      timeoutLow: opts.timeoutLow,
      timeoutHigh: opts.timeoutHigh,
      recoverExclude: opts.recoverExclude,
    },
  })

  sbot.name = opts.name
  sbot.ebt.registerFormat(bendyButtFormat)

  return sbot
}

function mfSeedFromName(name) {
  if (!name) return

  switch (name) {
    case 'alice':
      return Buffer.from(
        '000000000000000000000000000000000000000000000000000000000000a1ce',
        'hex'
      )
    case 'bob':
      return Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000000b0b',
        'hex'
      )
    case 'carol':
      return Buffer.from(
        '00000000000000000000000000000000000000000000000000000000000ca201',
        'hex'
      )
    case 'david':
      return Buffer.from(
        '00000000000000000000000000000000000000000000000000000000000da71d',
        'hex'
      )
    case 'oscar':
      return Buffer.from(
        '0000000000000000000000000000000000000000000000000000000000005ca4',
        'hex'
      )

    default:
      throw new Error('no mfSeed set up for ' + name)
  }
}
