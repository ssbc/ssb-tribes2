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
const Testbot = require('./helpers/testbot')
const countGroupFeeds = require('./helpers/count-group-feeds')

test('create', async (t) => {
  const ssb = Testbot()

  const { id, subfeed, writeKey, readKeys, root } = await ssb.tribes2
    .create()
    .catch(t.error)

  t.true(isIdentityGroupSSBURI(id), 'has group id')
  t.true(Buffer.isBuffer(writeKey.key), 'has writeKey')
  t.true(Buffer.isBuffer(readKeys[0].key), 'has readKey')
  t.true(isClassicMessageSSBURI(root), 'has root')
  t.true(Ref.isFeed(subfeed.id), 'has subfeed')

  await p(ssb.close)(true)
})

// this is more of an integration test over the api
test('create more', async (t) => {
  const ssb = Testbot()

  const group = await ssb.tribes2.create().catch(t.fail)

  const rootFeed = await p(ssb.metafeeds.findOrCreate)().catch(t.fail)

  t.true(isIdentityGroupSSBURI(group.id), 'returns group identifier - groupId')
  t.true(
    Buffer.isBuffer(group.writeKey.key) && group.writeKey.key.length === 32,
    'returns group symmetric key - groupSecret'
  )

  const msgVal = await p(ssb.db.get)(group.root).catch(t.fail)

  const root = await p(ssb.metafeeds.findOrCreate)()

  t.deepEqual(
    msgVal.content,
    {
      type: 'group/init',
      version: 'v2',
      secret: group.writeKey.key.toString('base64'),
      tangles: {
        group: { root: null, previous: null },
        epoch: { root: null, previous: null },
        members: { root: null, previous: null },
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
      secret: group.writeKey.key.toString('base64'),
      oldSecrets: [],
      creator: rootFeed.id,
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

  await alice.tribes2.start()
  const group = await alice.tribes2.create().catch(t.fail)

  const kvt = await p(alice.db.getMsg)(group.root).catch(t.fail)

  t.true(kvt.meta && kvt.meta.private, 'encrypted init msg')

  await p(alice.close)(true)
})

function createEmptyGroupFeed({ server, root }, cb) {
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
    cb
  )
}

test('create reuses an unused group feed (because of an earlier crash or something)', (t) => {
  const server = Testbot()

  server.metafeeds.findOrCreate((err, root) => {
    if (err) t.fail(err)

    t.pass('got root')

    countGroupFeeds(server, (err, num) => {
      if (err) t.fail(err)

      t.equal(num, 0, 'there are no group feeds yet')

      server.tribes2.create(null, (err) => {
        if (err) t.fail(err)

        countGroupFeeds(server, (err, num) => {
          if (err) t.fail(err)
          t.equal(num, 1, 'there is 1 group feed after we created a group')

          createEmptyGroupFeed({ server, root }, (err) => {
            if (err) t.fail(err)

            countGroupFeeds(server, (err, num) => {
              if (err) t.fail(err)
              t.equal(
                num,
                2,
                'there is 1 used group feed and 1 dummy one, the empty one we created now'
              )

              server.tribes2.create(null, (err) => {
                if (err) t.fail(err)

                countGroupFeeds(server, (err, num) => {
                  if (err) t.fail(err)

                  t.equal(
                    num,
                    2,
                    'there are still only 2 group feeds after creating another group. the empty one got used by create()'
                  )

                  server.close(true, t.end)
                })
              })
            })
          })
        })
      })
    })
  })
})

test("create reuses a group feed that hasn't had members yet (because of an earlier crash or something)", (t) => {
  const server = Testbot()

  server.metafeeds.findOrCreate((err, root) => {
    if (err) t.fail(err)

    t.pass('got root')

    countGroupFeeds(server, (err, num) => {
      if (err) t.fail(err)

      t.equal(num, 0, 'there are no group feeds yet')

      server.tribes2.create(null, (err) => {
        if (err) t.fail(err)

        countGroupFeeds(server, (err, num) => {
          if (err) t.fail(err)
          t.equal(num, 1, 'there is 1 group feed after we created a group')

          createEmptyGroupFeed({ server, root }, (err, groupFeed) => {
            if (err) t.fail(err)

            const secret = new SecretKey(
              Buffer.from(groupFeed.purpose, 'base64')
            )
            const content = {
              type: 'group/init',
              version: 'v2',
              secret: groupFeed.purpose,
              tangles: {
                group: { root: null, previous: null },
                members: { root: null, previous: null },
                epoch: { root: null, previous: null },
              },
            }
            const recps = [
              { key: secret.toBuffer(), scheme: keySchemes.private_group },
              root.id,
            ]
            server.db.create(
              {
                keys: groupFeed.keys,
                content,
                recps,
                encryptionFormat: 'box2',
              },
              (err) => {
                if (err) t.fail(err)

                countGroupFeeds(server, (err, num) => {
                  if (err) t.fail(err)
                  t.equal(
                    num,
                    2,
                    'there is 1 used group feed and 1 we created now with a root message but not ourselves as a member'
                  )

                  server.tribes2.create(null, (err) => {
                    if (err) t.fail(err)

                    countGroupFeeds(server, (err, num) => {
                      if (err) t.fail(err)

                      t.equal(
                        num,
                        2,
                        'there are still only 2 group feeds after creating another group. the unused one got used by create()'
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
})
