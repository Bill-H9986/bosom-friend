/** 创作面板辅助：打开内容创作页并等待产品界面。 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

export function testid(page, id) {
  return page.locator('[data-testid="' + id + '"]').first()
}

export async function openPanel(app) {
  const page = await app.firstWindow()
  await page.getByText(/内容创作|数据中心|AI互动/).first().waitFor({ state: 'visible', timeout: 120000 })
  await page.getByText('内容创作', { exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(2500)
  return page
}

export function evidencePath(name) {
  return join(repoRoot, 'products/bosom-friend/qa/evidence/checklist-2026-09-04', name)
}
