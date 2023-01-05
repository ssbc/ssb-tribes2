// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: CC0-1.0

const test = require('tape')
const { isClassicMessageSSBURI, isIdentityGroupSSBURI } = require('ssb-uri2')
const { SecretKey } = require('ssb-private-group-keys')
const { keySchemes } = require('private-group-spec')
const Ref = require('ssb-ref')
const { promisify: p } = require('util')
const { where, type, toPromise } = require('ssb-db2/operators')
const pull = require('pull-stream')
const Testbot = require('./helpers/testbot')

test('create', async (t) => {
  const ssb = Testbot()

  const { id, subfeed, secret, root } = await ssb.tribes2
    .create()
    .catch(t.error)

  t.true(isIdentityGroupSSBURI(id), 'has group id')
  t.true(Buffer.isBuffer(secret), 'has secret')
  t.true(isClassicMessageSSBURI(root), 'has root')
  t.true(Ref.isFeed(subfeed.id), 'has subfeed')

  await p(ssb.close)(true)
})

// this is more of an integration test over the api
test('create more', async (t) => {
  const ssb = Testbot()

  const group = await ssb.tribes2.create().catch(t.fail)

  t.true(isIdentityGroupSSBURI(group.id), 'returns group identifier - groupId')
  t.true(
    Buffer.isBuffer(group.secret) && group.secret.length === 32,
    'returns group symmetric key - groupKey'
  )

  const msgVal = await p(ssb.db.get)(group.root).catch(t.fail)

  const root = await p(ssb.metafeeds.findOrCreate)()

  t.deepEqual(
    msgVal.content,
    {
      type: 'group/init',
      tangles: {
        group: { root: null, previous: null },
      },
    },
    'can decrypt group/init'
  )

  // check I published a group/add-member to myself
  const msgs = await ssb.db.query(where(type('group/add-member')), toPromise())

  t.equals(msgs.length, 1, 'published only one group/add-member message')

  t.deepEqual(
    msgs[0].value.content, // contents of the latest message
    {
      type: 'group/add-member',
      version: 'v2',
      secret: group.secret.toString('base64'),
      root: group.root,
      recps: [group.id, root.id], // me being added to the group
      tangles: {
        members: {
          root: group.root,
          previous: [group.root],
        },
        group: {
          root: group.root,
          previous: [group.root],
        },
      },
    },
    'The admin was was also added to the group'
  )

  await p(ssb.close)(true)
})

test('root message is encrypted', async (t) => {
  const alice = Testbot()

  alice.tribes2.start()
  const group = await alice.tribes2.create().catch(t.fail)

  const kvt = await p(alice.db.getMsg)(group.root).catch(t.fail)

  t.true(kvt.meta && kvt.meta.private, 'encrypted init msg')

  await p(alice.close)(true)
})

//TODO
test.skip('tribes.create (opts.addPOBox)', (t) => {
  const server = Testbot()

  // this is more of an integration test over the api
  server.tribes.create({ addPOBox: true }, (err, data) => {
    if (err) throw err

    t.true(isPoBox(data.poBoxId), 'data.poBoxId')

    server.close()
    t.end()
  })
})

test('create reuses an unused group feed (because of an earlier crash or something)', (t) => {
  const server = Testbot()

  function countGroupFeeds(cb) {
    pull(
      server.metafeeds.branchStream({ old: true, live: false }),
      pull.map((branch) => {
        //console.log('branch', branch)
        return branch
      }),
      pull.filter((branch) => branch.length === 4),
      pull.map((branch) => branch[3]),
      pull.filter((feed) => feed.recps),
      pull.collect((err, feeds) => {
        if (err) return cb(err)
        console.log('feeds len', feeds.length)
        server.metafeeds.printTree(server.id, { id: true }, () => {})
        return cb(null, feeds.length)
      })
    )
  }

  server.metafeeds.findOrCreate((err, root) => {
    if (err) t.fail(err)

    t.pass('got root')
    //console.log('root', root)

    countGroupFeeds((err, num) => {
      if (err) t.fail(err)

      t.equal(num, 0, 'there are no group feeds yet')

      server.tribes2.create(null, (err) => {
        if (err) t.fail(err)

        countGroupFeeds((err, num) => {
          if (err) t.fail(err)
          t.equal(num, 1, 'there is 1 group feed after we created a group')

          const secret = new SecretKey()
          server.metafeeds.findOrCreate(
            {
              purpose: secret.toString(),
              feedFormat: 'classic',
              recps: [
                { key: secret.toBuffer(), scheme: keySchemes.private_group },
                root.id,
              ],
              encryptionFormat: 'box2',
            },
            (err) => {
              if (err) t.fail(err)

              countGroupFeeds((err, num) => {
                if (err) t.fail(err)
                t.equal(
                  num,
                  2,
                  'there is 1 used group feed and 1 dummy one, the empty one we created now'
                )

                server.tribes2.create(null, (err) => {
                  if (err) t.fail(err)

                  console.log('created second group')

                  countGroupFeeds((err, num) => {
                    if (err) t.fail(err)

                    console.log('counted feeds again')

                    t.equal(
                      num,
                      2,
                      'there are still only 2 group feeds after creating another group. the empty one got used by create()'
                    )

                    server.close(true, t.end)
                  })
                })
              })
            }
          )
        })
      })
    })
  })
})
