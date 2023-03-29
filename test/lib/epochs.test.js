const test = require('tape')
const { promisify: p } = require('util')

const Server = require('../helpers/testbot')


test('lib/epochs', async t => {
  const ssb = Server()


  t.end()
})
