const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readProductJson, writeProductJson } = require('../atomic-json.cjs')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-storage-test-'))
const file = path.join(tempRoot, 'data.json')

try {
  const created = readProductJson(file, [])
  assert.strictEqual(Array.isArray(created), true)
  assert.deepStrictEqual(created.slice(0, 0), [])

  created.push({ id: 'one', title: 'first' })
  writeProductJson(file, created)

  const reloaded = readProductJson(file)
  assert.strictEqual(reloaded.length, 1)
  assert.strictEqual(reloaded[0].id, 'one')

  const badFile = path.join(tempRoot, 'bad.json')
  fs.writeFileSync(badFile, JSON.stringify({ schemaVersion: 99, value: {} }), 'utf8')
  assert.throws(() => readProductJson(badFile, {}, 1), /Schema mismatch/)
  console.log('STORAGE_UNIT_OK')
}
finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
