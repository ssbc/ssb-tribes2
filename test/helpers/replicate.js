// SPDX-FileCopyrightText: 2022 Jacob Karlsson <jacob.karlsson95@gmail.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')

/**
 * Fully replicates person1's feed to person2 and vice versa
 */
module.exports = async function replicate(person1, person2, opts = {}) {
  const clock1 = await p(person1.ebt.clock)()
  const clock2 = await p(person2.ebt.clock)()
  person1.ebt.request(person1.id, true)
  person2.ebt.request(person2.id, true)
  person1.ebt.request(person2.id, true)
  person2.ebt.request(person1.id, true)
  await p(person1.connect)(person2.getAddress())
  await new Promise((res) => {
    const interval = setInterval(async () => {
      const nowPerson1Clock = await p(person1.ebt.clock)()
      const isSynced1 = nowPerson1Clock[person2.id] === clock2[person2.id]
      const nowPerson2Clock = await p(person2.ebt.clock)()
      const isSynced2 = nowPerson2Clock[person1.id] === clock1[person1.id]

      if (isSynced1 && isSynced2) {
        clearInterval(interval)
        res()
      }
    }, 100)
  })
  if (opts.waitUntilMembersOf) {
    await waitUntilMember(person1, opts.waitUntilMembersOf)
    await waitUntilMember(person2, opts.waitUntilMembersOf)
  }
}

async function waitUntilMember(person, groupId) {
  let isMember = false
  for (let i = 0; !isMember && i < 50; i++) {
    await person.tribes2
      .get(groupId)
      .then(() => {
        isMember = true
      })
      .catch(() => {})
    await p(setTimeout)(100)
  }
}
