// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const { promisify: p } = require('util')
const pull = require('pull-stream')
const { isClassicMessageSSBURI, isIdentityGroupSSBURI } = require('ssb-uri2')
const Testbot = require('./helpers/testbot')

test('tribes.list + tribes.get', (t) => {
  const name = `list-and-get-groups-${Date.now()}`
  let server = Testbot({ name })
  const keys = server.keys

  server.tribes2.create(null, (err, group) => {
    t.error(err, 'create group')

    pull(
      server.tribes2.list(),
      pull.collect(async (err, list) => {
        t.error(err, 'no error')

        const expectedGroup = {
          secret: group.secret,
          root: group.root,
          id: group.id,
        }

        t.deepEqual(list, [expectedGroup], 'lists group ids')

        server.tribes2.get(group.id, (err, actualGroup) => {
          t.error(err, 'no error')

          t.deepEqual(actualGroup, expectedGroup, 'gets group data')

          server.close((err) => {
            t.error(err, 'closes server')

            server = Testbot({ name, rimraf: false, keys })
            pull(
              server.tribes2.list(),
              pull.collect((err, newList) => {
                t.error(err, 'no error')

                t.deepEqual(
                  newList,
                  list,
                  'list returns save results after restart'
                )
                server.close(true, t.end)
              })
            )
          })
        })
      })
    )
  })
})

test.skip('tribes.list (subtribes)', async (t) => {
  const server = Server()

  const { groupId } = await p(server.tribes.create)({})
  const { groupId: subGroupId } = await p(server.tribes.subtribe.create)(
    groupId,
    {}
  )

  let list = await p(server.tribes.list)()

  t.deepEqual(list, [groupId], 'excludes subtribes by default')

  list = await p(server.tribes.list)({ subtribes: true })

  t.deepEqual(
    list,
    [groupId, subGroupId],
    '{ subtribes: true } includes subtribes'
  )

  server.close()
  t.end()
})

test('get', async (t) => {
  const ssb = Testbot()

  const { id, subfeed, secret, root } = await ssb.tribes2
    .create()
    .catch(t.error)

  const group = await ssb.tribes2.get(id)

  //- `subfeed` *Keys* - the keys of the subfeed you should publish group data to
  t.equal(id, group.id)
  t.true(isIdentityGroupSSBURI(group.id))
  //TODO: subfeed
  t.true(Buffer.isBuffer(group.secret))
  t.equal(secret, group.secret)
  t.true(isClassicMessageSSBURI(group.root), 'has root')
  t.equal(root, group.root)

  await p(ssb.close)(true)
})

test('list', (t) => {
  const ssb = Testbot()

  ssb.tribes2
    .create()
    .then(({ id: id1, secret: secret1 }) => {
      t.true(isIdentityGroupSSBURI(id1), 'has id')

      pull(
        ssb.tribes2.list(),
        pull.collect(async (err, groups1) => {
          t.error(err, 'no error')

          t.equal(groups1.length, 1, 'lists the 1 group')

          const { id: id2 } = await ssb.tribes2.create().catch(t.error)

          pull(
            ssb.tribes2.list(),
            pull.collect(async (err, groups2) => {
              t.error(err, 'no error')

              t.equal(groups2.length, 2)
              t.equal(groups2[0].id, id1)
              t.equal(groups2[0].secret, secret1)
              t.equal(groups2[1].id, id2)

              ssb.close(true, t.end)
            })
          )
        })
      )
    })
    .catch(t.error)
})
