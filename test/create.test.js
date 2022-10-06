// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const ref = require('ssb-ref')
const { promisify: p } = require('util')
const pull = require('pull-stream')
const { author, descending, toPullStream, where } = require('ssb-db2/operators')
const Testbot = require('./helpers/testbot')

test('create', async (t) => {
  const ssb = Testbot()

  const { id, subfeed, secret, root } = await ssb.tribes2
    .create()
    .catch(t.error)

  t.true(ref.isCloakedMsgId(id), 'has id')
  t.true(Buffer.isBuffer(secret), 'has secret')
  t.true(ref.isMsg(root), 'has root')
  //TODO
  //t.true(subfeed && ref.isFeed(subfeed.id), 'has subfeed')

  const content = {
    type: 'post',
    text: 'hello this is test',
    recps: [id],
  }

  const msg = await p(ssb.db.create)({
    content,
    //keys: subfeed.keys,
    encryptionFormat: 'box2',
  }).catch(t.error)

  t.equal(typeof msg.value.content, 'string', 'content is a string')
  //t.equal(msg.value.author, subfeed.id)
  // create, add self, post
  t.equal(msg.value.sequence, 3, 'this is the 3rd msg')

  await p(ssb.close)(true)
})

test('create more', (t) => {
  const server = Testbot()

  // this is more of an integration test over the api
  server.tribes2.create({}, (err, data) => {
    if (err) throw err

    const { id, secret, root } = data
    t.true(ref.isCloakedMsg(id), 'returns group identifier - groupId')
    t.true(
      Buffer.isBuffer(secret) && secret.length === 32,
      'returns group symmetric key - groupKey'
    )
    //TODO: can we get the root msg unencrypted?
    //t.match(
    //  groupInitMsg.value.content,
    //  /^[a-zA-Z0-9/+]+=*\.box2$/,
    //  'encrypted init msg'
    //)

    server.db.get(root, (err, value) => {
      if (err) throw err

      t.deepEqual(
        value.content,
        {
          type: 'group/init',
          tangles: {
            group: { root: null, previous: null },
          },
        },
        'can decrypt group/init'
      )

      // check I published a group/add-member to myself
      pull(
        server.db.query(where(author(server.id)), descending(), toPullStream()),
        pull.map((msg) => msg.value.content),
        pull.collect((err, msgContents) => {
          if (err) throw err

          t.deepEqual(
            msgContents[0], // contents of the latest message
            {
              type: 'group/add-member',
              version: 'v1',
              groupKey: secret.toString('base64'),
              root: root,
              recps: [id, server.id], // me being added to the group
              tangles: {
                members: {
                  root: root,
                  previous: [root],
                },
                group: {
                  root: root,
                  previous: [root],
                },
              },
            },
            'The admin was was also added to the group'
          )
          server.close()
          t.end()
        })
      )
    })
  })
})

//TODO
test.skip('tribes.create (opts.addPOBox)', (t) => {
  const server = Server()

  // this is more of an integration test over the api
  server.tribes.create({ addPOBox: true }, (err, data) => {
    if (err) throw err

    t.true(isPoBox(data.poBoxId), 'data.poBoxId')

    server.close()
    t.end()
  })
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
