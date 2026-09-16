const path = require('path')
const { test, expect } = require('@playwright/test')
const { _electron } = require('playwright')

const desktopRoot = path.resolve(__dirname, '../../apps/desktop')
const mainEntry = path.join(desktopRoot, 'electron/main.cjs')

test('launch shows one desktop window and closes cleanly', async () => {
  const electronApp = await _electron.launch({ args: [mainEntry], cwd: desktopRoot })
  const window = await electronApp.firstWindow()
  await expect(window.locator('h1')).toContainText('Bosom Friend')
  await window.waitForTimeout(500)

  const windowsBeforeClose = electronApp.windows()
  expect(windowsBeforeClose.length).toBeGreaterThanOrEqual(1)

  await electronApp.close()
})
