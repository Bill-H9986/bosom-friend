const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './specs',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
})
