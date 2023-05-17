// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: Unlicense

module.exports = function Run(t) {
  // this function takes care of running a promise and logging
  // (or testing) that it happens and any errors are handled
  return async function run(label, promise, opts = {}) {
    const { isTest = true, timer = false, logError = false } = opts

    if (timer) console.time('> ' + label)
    return promise
      .then((res) => {
        if (isTest) t.pass(label)
        return res
      })
      .catch((err) => {
        t.error(err, label)
        if (logError) console.error(err)
      })
      .finally(() => timer && console.timeEnd('> ' + label))
  }
}
