// SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros <contact@staltz.com>
//
// SPDX-License-Identifier: LGPL-3.0-only

const chunk = require('lodash.chunk')
const pull = require('pull-stream')
const clarify = require('clarify-error')
const Epochs = require('./epochs')

function reAddMembers(ssb, groupId, opts, cb) {
  const epochs = Epochs(ssb)

  epochs.getPreferredEpoch(groupId, (err, preferredEpoch) => {
    // prettier-ignore
    if (err) return cb(clarify(err, "Couldn't get preferred epoch when re-adding members"))

    epochs.getMissingMembers(groupId, (err, missingMembersEveryEpoch) => {
      // prettier-ignore
      if (err) return cb(clarify(err, "Couldn't find missing members after exclusion"))

      // to pretend-fail in tests
      const keepMember = (memberId) =>
        opts?._reAddSkipMember ? memberId !== opts?._reAddSkipMember : true

      const missingMembers = missingMembersEveryEpoch
        .find((epoch) => epoch.epoch === preferredEpoch.id)
        ?.missing.filter(keepMember)

      if (!missingMembers?.length) return cb()

      pull(
        pull.values(chunk(missingMembers, 15)),
        pull.asyncMap((membersToAdd, cb) =>
          ssb.tribes2.addMembers(
            groupId,
            membersToAdd,
            { oldSecrets: false },
            cb
          )
        ),
        pull.collect((err) => {
          // prettier-ignore
          if (err) return cb(clarify(err, "Couldn't re-add remaining members after exclusion"))
          cb()
        })
      )
    })
  })
}

module.exports = {
  reAddMembers,
}
