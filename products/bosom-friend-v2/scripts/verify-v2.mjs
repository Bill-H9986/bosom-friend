import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const failures = []

function check(label, condition) {
  if (!condition)
    failures.push(label)
}

const rootPackage = JSON.parse(read('package.json'))
const desktopPackage = JSON.parse(read('apps/desktop/package.json'))
const main = read('apps/desktop/electron/main.cjs')
const preload = read('apps/desktop/electron/preload.cjs')
const renderer = read('apps/desktop/renderer/index.html')
const builder = read('apps/desktop/electron-builder.yml')
const storage = read('packages/storage/src/atomic-json.cjs')
const lifecycle = read('packages/lifecycle/src/process-registry.cjs')

check('root version is 0.2.0', rootPackage.version === '0.2.0')
check('desktop version is 0.2.0', desktopPackage.version === '0.2.0')

check('main sets contextIsolation', /contextIsolation:\s*true/.test(main))
check('main disables nodeIntegration', /nodeIntegration:\s*false/.test(main))
check('main enables renderer sandbox', /sandbox:\s*true/.test(main))
check('main uses single instance lock', /requestSingleInstanceLock/.test(main))
check('main handles before-quit', /before-quit/.test(main))
check('main owns managed children', /stopManagedChildren/.test(main))
check('main does not disable sandbox', !/--no-sandbox/.test(main))
check('main does not open external browser', !/shell\.openExternal/.test(main))
check('main does not enumerate process names', !/Get-CimInstance/.test(main))
check('main does not kill by process name', !/taskkill\.exe[^\n]*Name/i.test(main))

check('preload does not expose raw ipcRenderer', !/exposeInMainWorld\([^,]+,\s*ipcRenderer/.test(preload))
check('renderer has CSP', /Content-Security-Policy/.test(renderer))

check('builder uses NSIS', /target:\s*nsis/.test(builder))
check('builder does not force launch', /runAfterFinish:\s*false/.test(builder))
check('builder creates desktop shortcut', /createDesktopShortcut:\s*true/.test(builder))
check('builder creates start menu shortcut', /createStartMenuShortcut:\s*true/.test(builder))

check('storage is schema versioned', /schemaVersion/.test(storage))
check('storage uses atomic rename', /renameSync/.test(storage))
check('lifecycle never scans process names', !/Get-CimInstance/.test(lifecycle))

if (failures.length > 0) {
  console.error('V2_GATE_FAIL')
  for (const failure of failures)
    console.error(` - ${failure}`)
  process.exit(1)
}

console.log('V2_GATE_OK')
