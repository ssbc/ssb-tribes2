// SPDX-FileCopyrightText: 2023 Mix Irving <mix@protozoa.nz>
//
// SPDX-License-Identifier: LGPL-3.0-only

let closeHooked = false
const calls = []

function hookClose(ssb) {
  if (closeHooked) return

  ssb.close.hook((close, args) => {
    close.apply(ssb, args)
    calls.forEach((fn) => fn())
  })

  closeHooked = true
}

// push a function to this list to have it called when the client is closing
hookClose.onClose = (call) => {
  if (!closeHooked) throw Error('onClose requires ssb.close to already be hooked!')

  if (typeof call === 'function') calls.push(call)
  else throw Error('addCall only accepts functions')
}

module.exports = hookClose
