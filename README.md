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
- TODO

```diff
 SecretStack({appKey: require('ssb-caps').shs})
   .use(require('ssb-master'))
+  .use(require('ssb-db2'))
   .use(require('ssb-conn'))
+  .use(require('ssb-tribes2'))
   .use(require('ssb-blobs'))
   .call(null, config)
```

TODO TODO

## License

LGPL-3.0-only
