/**
 * Versioned atomic JSON storage.
 *
 * Product data files are written to a schema envelope, then to a temporary sibling
 * file, fsynced, and renamed. This prevents a crash from leaving a half-written product
 * state and makes the schema version observable on disk.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const DEFAULT_SCHEMA_VERSION = 1

function cloneDefault(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function readProductJson(file, fallback = [], expectedVersion = DEFAULT_SCHEMA_VERSION) {
  if (!fs.existsSync(file)) {
    const initial = cloneDefault(fallback)
    writeProductJson(file, initial, expectedVersion)
    return initial
  }

  const raw = fs.readFileSync(file, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  }
  catch (error) {
    throw new Error(`Corrupt product data ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'schemaVersion')) {
    throw new Error(`Invalid product data ${file}: expected schema envelope`)
  }

  if (value.schemaVersion !== expectedVersion) {
    throw new Error(
      `Schema mismatch ${file}: got ${String(value.schemaVersion)}, expected ${expectedVersion}`,
    )
  }
  return value.value
}

function writeProductJson(file, value, expectedVersion = DEFAULT_SCHEMA_VERSION) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })

  const payload = {
    schemaVersion: expectedVersion,
    value,
  }

  const temp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  )
  const fd = fs.openSync(temp, 'w')
  try {
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    fs.fsyncSync(fd)
  }
  finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}

module.exports = {
  DEFAULT_SCHEMA_VERSION,
  readProductJson,
  writeProductJson,
}
