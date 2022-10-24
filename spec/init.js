// SPDX-FileCopyrightText: 2022 Mix Irving
//
// SPDX-License-Identifier: LGPL-3.0-only

const Validator = require('is-my-ssb-valid')
const schema = require('private-group-spec').schema.group.init

module.exports = {
  isValid: Validator(schema),
}
