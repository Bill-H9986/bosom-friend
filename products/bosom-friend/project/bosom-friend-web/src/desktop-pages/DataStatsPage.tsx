/**
 * 数据中心页（从账号管理拆分为独立页面）。
 * 复用 data-statistics 路由已有的 DataStatisticsClient（命名导出）；账号管理页不再内嵌。
 */
import dynamic from '@web/next-shims/dynamic'

const DataStatisticsCore = dynamic(
  () => import('@web/app/[lng]/data-statistics/DataStatisticsClient').then(m => m.DataStatisticsClient),
  { loading: null },
)

export default function DataStatsPage() {
  return <DataStatisticsCore />
}
