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
```

Then

```js
ssb.tribes2.start()

ssb.tribes2.create({}, (err, group) => {
  ssb.db.create(
    {
      keys: group.mySubfeedKeys,
      content: {
        type: 'post',
        text: 'welcome to the group',
        recps: [group.id],
      },
      encryptionFormat: 'box2',
    },
    cb
  )
})
```

## API

All methods with callbacks return a promise instead if a callback isn't provided.

### `ssb.tribes2.create(opts, cb)`

Creates a new private group.
This creates an encryption key, sets up a sub-feed for the group, and initializes the
group with a `group/init` message, and `group/add-member` to signal you were added.
Calls back with important info about the group.

- `opts` _Object_ - currently empty, but will be used in the future to specify details like whether the group has an admin subgroup, etc.
- `cb` _Function_ - callback function of signature `(err, group)` where `group` is an object containing:
  - `id` _CloakedId_ - a cipherlink that's safe to use publicly to name the group, and is used in `recps` to trigger encrypting messages to that group, encoded as an ssb-uri
  - `subfeed` _Keys_ - the keys of the subfeed you should publish group data to
  - `secret` _Buffer_ - the symmetric key used by the group for encryption
  - `root` _MessagedId_ - the MessageId of the `group/init` message of the group, encoded as an ssb-uri.

### `ssb.tribes2.get(groupId, cb)`

Gets information about a specific group.

- `groupId` _CloakedId_ - the public-safe cipherlink which identifies the group
- `cb` _Function_ - callback function of signature `(err, group)` where `group` is an object on the same format as the `group` object returned by #create

### `ssb.tribes2.list() => source`

Creates a pull-stream source which emits `group` data of each private group you're a part of.
(Same format as `group` object returned by #create)

### `ssb.tribes2.addMembers(groupId, feedIds, cb)`

Publish `group/add-member` messages to a group of peers, which gives them all the details they need
to join the group.

- `groupId` _CloakedId_ - the public-safe cipherlink which identifies the group (same as in #create)
- `feedIds` _[FeedId]_ - an Array of 1-16 different ids for peers (accepts ssb-uri or sigil feed ids)
- `cb` _Function_ - a callback of signature `(err, msg)`

### `ssb.tribes2.publish(content, cb)`

Publishes any kind of message encrypted to the group. The function wraps `ssb.db.create()` but handles adding tangles and using the correct encryption for the `content.recps` that you've provided. Mutates `content`.

- `cb` _Function_ - a callback of signature `(err, msg)`

### `ssb.tribes2.listMembers(groupId) => source`

Returns a pull stream source listing every known member of the group with id `groupId`.

### `ssb.tribes2.start()`

Starts this module listening for `group/add-member` messages, which will then trigger replication
changes and new encryption / indexing as required.

## License

LGPL-3.0-only
