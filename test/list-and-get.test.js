// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const test = require('tape')
const { promisify: p } = require('util')
const pull = require('pull-stream')
const ref = require('ssb-ref')
const Testbot = require('./helpers/testbot')

test('tribes.list + tribes.get', (t) => {
  const name = `list-and-get-groups-${Date.now()}`
  let server = Server({ name })
  const keys = server.keys

  server.tribes.create(null, (err, data) => {
    t.error(err, 'create group')

    server.tribes.list((err, list) => {
      if (err) throw err
      t.deepEqual(list, [data.groupId], 'lists group ids')

      server.tribes.get(data.groupId, (err, actualGroup) => {
        if (err) throw err

        const expectedGroup = {
          key: data.groupKey,
          root: data.groupInitMsg.key,
          scheme: 'envelope-large-symmetric-group',
          groupId: data.groupId,
        }
        t.deepEqual(actualGroup, expectedGroup, 'gets group data')

        server.close((err) => {
          t.error(err, 'closes server')

          server = Server({ name, startUnclean: true, keys })
          server.tribes.list((err, newList) => {
            if (err) throw err

            t.deepEqual(
              newList,
              list,
              'list returns save results after restart'
            )
            server.close(t.end)
          })
        })
      })
    })
  })
})

test('tribes.list (subtribes)', async (t) => {
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
  t.true(ref.isCloakedMsg(group.id))
  //TODO: subfeed
  t.true(Buffer.isBuffer(group.secret))
  t.equal(secret, group.secret)
  t.true(ref.isMsg(group.root), 'has root')
  t.equal(root, group.root)

  await p(ssb.close)(true)
})

test('list', (t) => {
  const ssb = Testbot()

  ssb.tribes2
    .create()
    .then(({ id: id1, secret: secret1 }) => {
      t.true(ref.isCloakedMsgId(id1), 'has id')

      pull(
        ssb.tribes2.list(),
        pull.collect(async (err, groups1) => {
          if (err) t.error(err)

          t.equal(groups1.length, 1, 'lists the 1 group')

          const { id: id2 } = await ssb.tribes2.create().catch(t.error)

          pull(
            ssb.tribes2.list(),
            pull.collect(async (err, groups2) => {
              if (err) return t.error(err)

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
