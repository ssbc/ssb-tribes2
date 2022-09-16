<!--
SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>

SPDX-License-Identifier: CC0-1.0
-->

# ssb-tribes2

TODO TODO

## Installation

```bash
npm install ssb-tribes2
```

## Usage in ssb-db2

- Requires **Node.js 12** or higher
- Requires `secret-stack@^6.2.0`
- Requires `ssb-db2@>=5.0.0`
- Requires `ssb-box2@>2.0.2`
- TODO

```diff
 const ssb = SecretStack({ caps: require('ssb-caps') })
   .use(require('ssb-master'))
+  .use(require('ssb-db2'))
   .use(require('ssb-conn'))
+  .use(require('ssb-box2'))
+  .use(require('ssb-tribes2'))
   .use(require('ssb-blobs'))
   .call(null, config)

ssb.tribes2.start()

ssb.tribes2.create({}, (err, group) => {
  const content = {
    type: 'post',
    text: 'welcome to the group',
    recps: [group.id]
  }
  ssb.db.publishAs(group.subfeed, content, cb)
})
```

## API


### `ssb.tribes2.create(opts, cb)`

Creates a new private group.
This creates an encruption key, sets up a sub-feed for the group, and initializes the
group with a `group/init` message, and `group/add-member` to signal you were added.
Calls back with important info about the group

- `opts` *Object* - currently empty, but will be used to specifiy details like whether the group has an admin subgroup etc. in future
- `cb` *Function* - callback function of signature `(err, group)` where `group` is an object containing:
    - `id` *CloakedId* - a cipherlink that's safe to use publicly to name the group, and is used in `recps` to trigger encrypting messages to that group, encoded as an ssb-uri
    - `subfeed` *Keys* - the keys of the subfeed you should publish group data to
    - `secret` *Buffer* - the symmetric key used by the group for encryption
    - `root` *MessagedId* - the MessageId of the `group/init` message of the group, encoded as an ssb-uri.


### `ssb.tribes2.list() => source`

Creates a pull-stream source which emits `group` data of each private group you're a part of.
(Same format as `group` Object returned in by #create)

### `ssb.tribes2.addMembers(groupId, feedIds, cb)`

Publish `group/add-member` messages to a group of peers, which gives them all the details they need
to join the group.

- `groupId` *CloakedId* - the public-safe cipherlink which identifies the group (same as in #create)
- `feedIds` *[FeedId]* - an Array of 1-16 different ids for peers (accepts ssb-uri or sigil feed ids)
- `cb` *Function* - a callback of signature `(err)`


### `ssb.tribes2.start()`

Starts this module listening for `group/add-member` messages, which will then trigger replication
changes and new encryption / indexing as required.


## License

LGPL-3.0-only
