const chunk = require('lodash.chunk')
const pull = require('pull-stream')
const clarify = require('clarify-error')
const Epochs = require('./epochs')

function reAddMembers(ssb, groupId, cb) {
  const epochs = Epochs(ssb)

  epochs.getPreferredEpoch(groupId, (err, preferredEpoch) => {
    // prettier-ignore
    if (err) return cb(clarify(err, "Couldn't get preferred epoch when re-adding members"))

    epochs.getMissingMembers(groupId, (err, missingMembersEveryEpoch) => {
      // prettier-ignore
      if (err) return cb(clarify(err, "Couldn't find missing members after exclusion"))

      const missingMembers = missingMembersEveryEpoch.find(
        (epoch) => epoch.epoch === preferredEpoch.id
      ).missing

      console.log('missing members', missingMembers)

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
          cb(null)
        })
      )
    })
  })
}

module.exports = {
  reAddMembers,
}
