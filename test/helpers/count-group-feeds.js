const pull = require('pull-stream')

module.exports = function countGroupFeeds(server, cb) {
  pull(
    server.metafeeds.branchStream({ old: true, live: false }),
    pull.filter((branch) => branch.length === 4),
    pull.map((branch) => branch[3]),
    pull.filter((feed) => feed.recps),
    pull.collect((err, feeds) => {
      if (err) return cb(err)
      return cb(null, feeds.length)
    })
  )
}
