// SPDX-FileCopyrightText: 2022 Jacob Karlsson <jacob.karlsson95@gmail.com>
//
// SPDX-License-Identifier: CC0-1.0

const { promisify: p } = require('util')
const pull = require('pull-stream')
const deepEqual = require('fast-deep-equal')

/**
 * Fully replicates person1's feed to person2 and vice versa
 */
module.exports = async function replicate(person1, person2, opts = {}) {
  // Replicate self
  person1.ebt.request(person1.id, true)
  person2.ebt.request(person2.id, true)

  // Replicate each other's main feeds
  person1.ebt.request(person2.id, true)
  person2.ebt.request(person1.id, true)

  const person1Root = await p(person1.metafeeds.findOrCreate)()
  const person2Root = await p(person2.metafeeds.findOrCreate)()

  // Replicate each other's metafeed roots
  person1.ebt.request(person1Root.id, true)
  person1.ebt.request(person2Root.id, true)
  person2.ebt.request(person1Root.id, true)
  person2.ebt.request(person2Root.id, true)

  // person1 replicate all the trees in their forest, from top to bottom
  let drain1
  pull(
    person1.metafeeds.branchStream({ old: true, live: true }),
    pull.flatten(),
    pull.map((feedDetails) => feedDetails.id),
    pull.unique(),
    (drain1 = pull.drain((feedId) => {
      person1.ebt.request(feedId, true)
      person2.ebt.request(feedId, true)
    }))
  )

  // person2 replicate all the trees in their forest, from top to bottom
  let drain2
  pull(
    person2.metafeeds.branchStream({ old: true, live: true }),
    pull.flatten(),
    pull.map((feedDetails) => feedDetails.id),
    pull.unique(),
    (drain2 = pull.drain((feedId) => {
      person1.ebt.request(feedId, true)
      person2.ebt.request(feedId, true)
    }))
  )

  // Establish a network connection
  const conn = await p(person1.connect)(person2.getAddress())

  // Wait until both have the same forest
  const tree1AtPerson1 = await p(getSimpleTree)(person1, person1Root.id)
  const tree2AtPerson2 = await p(getSimpleTree)(person2, person2Root.id)
  await retryUntil(async () => {
    const tree2AtPerson1 = await p(getSimpleTree)(person1, person2Root.id)
    const tree1AtPerson2 = await p(getSimpleTree)(person2, person1Root.id)
    // console.log('PERSON 1:')
    // await p(person1.metafeeds.printTree)(person1Root.id, { id: true })
    // await p(person1.metafeeds.printTree)(person2Root.id, { id: true })
    // console.log('PERSON 2:')
    // await p(person2.metafeeds.printTree)(person1Root.id, { id: true })
    // await p(person2.metafeeds.printTree)(person2Root.id, { id: true })
    // console.log('---------------------------')
    return (
      deepEqual(tree1AtPerson1, tree1AtPerson2) &&
      deepEqual(tree2AtPerson1, tree2AtPerson2)
    )
  })

  const feedIds1 = treeToIds(tree1AtPerson1)
  const feedIds2 = treeToIds(tree2AtPerson2)
  // console.log(feedIds1);
  // console.log(feedIds2);

  // Wait until both have replicated all feeds in full
  await retryUntil(async () => {
    const newClock1 = await p(person1.getVectorClock)()
    const newClock2 = await p(person2.getVectorClock)()
    // console.log('PERSON 1:', newClock1)
    // console.log('PERSON 2:', newClock2)
    // console.log('---------------------')
    for (const feedId of feedIds1) {
      if (newClock2[feedId] !== newClock1[feedId]) return false
    }
    for (const feedId of feedIds2) {
      if (newClock1[feedId] !== newClock2[feedId]) return false
    }
    return true
  })

  // Wait until they have computed that they are members of the group
  if (opts.waitUntilMembersOf) {
    const groupId = opts.waitUntilMembersOf
    await retryUntil(() =>
      person1.tribes2
        .get(groupId)
        .then(() => true)
        .catch(() => false)
    )
    await retryUntil(() =>
      person2.tribes2
        .get(groupId)
        .then(() => true)
        .catch(() => false)
    )
  }

  drain1.abort()
  drain2.abort()

  await p(conn.close)(true)
}

async function retryUntil(fn) {
  let result = false
  for (let i = 0; i < 100; i++) {
    result = await fn()
    if (result) return
    else await p(setTimeout)(100)
  }
  if (!result) throw new Error('retryUntil timed out')
}

function treeToIds(tree) {
  const ids = []
  ids.push(tree.id)
  function traverse(node) {
    for (const child of node.children) {
      ids.push(child.id)
      traverse(child)
    }
  }
  traverse(tree)
  return ids
}

// TODO: this is a copy of the same function in ssb-meta-feeds, we should
// probably just an opt there to generate this kind of tree (with only id)
function getSimpleTree(sbot, root, cb) {
  const tree = {}
  pull(
    sbot.metafeeds.branchStream({ root, old: true, live: false }),
    pull.drain(
      (branch) => {
        for (let i = 0; i < branch.length; i++) {
          const node = branch[i]
          if (i === 0) currentNode = tree
          else {
            const parent = currentNode
            currentNode = parent.children.find((child) => child.id === node.id)
            if (!currentNode) {
              parent.children.push((currentNode = {}))
            }
          }
          if (!currentNode.id) {
            currentNode.id = node.id
            currentNode.children = []
          }
        }
      },
      (err) => {
        if (err) return cb(err)
        cb(null, tree)
      }
    )
  )
}
