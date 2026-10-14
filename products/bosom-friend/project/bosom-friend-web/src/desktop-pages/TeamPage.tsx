import dynamic from '@web/next-shims/dynamic'

/**
 * TeamPage - 管家团队页（ADR-005 呈现层改造方案 v1.0 的 N1）
 *
 * 桌面页只做转发：页面实现在 `app/[lng]/team/page.tsx`，与其它 desktop-pages 一致，
 * 让 electron 路由表只认 `@web/desktop-pages/*` 这一个入口。
 */
const TeamPageContent = dynamic(
  () => import('../app/[lng]/team/page'),
  { loading: null },
)

export default function TeamPage() {
  return <TeamPageContent />
}
