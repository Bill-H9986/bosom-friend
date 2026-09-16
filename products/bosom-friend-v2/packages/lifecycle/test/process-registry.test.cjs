const assert = require('assert')
const { spawn } = require('child_process')
const { ProcessRegistry } = require('../src/process-registry.cjs')

async function main() {
  const registry = new ProcessRegistry()
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    windowsHide: true,
    stdio: 'ignore',
  })
  registry.register(child)
  assert.strictEqual(registry.pids().length, 1)

  await registry.stopAll(500)
  assert.strictEqual(registry.pids().length, 0)
  console.log('LIFECYCLE_UNIT_OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
