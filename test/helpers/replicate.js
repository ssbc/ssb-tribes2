// SPDX-FileCopyrightText: 2022 Jacob Karlsson <jacob.karlsson95@gmail.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')

module.exports = async function replicate(person1, person2) {
  person1.ebt.request(person1.id, true)
  person2.ebt.request(person2.id, true)
  person1.ebt.request(person2.id, true)
  person2.ebt.request(person1.id, true)
  await p(person1.connect)(person2.getAddress())
  await new Promise((res) => setTimeout(res, 3000))
}
