/**
 * 发布日历页（从账号管理拆分为独立页面）。
 * 复用账号域已有的 CalendarTiming 组件；账号管理页不再内嵌日历区块。
 */
import dynamic from '@web/next-shims/dynamic'

const CalendarCore = dynamic(() => import('@web/app/[lng]/accounts/components/CalendarTiming'), {
  loading: null,
})

export default function CalendarPage() {
  return <CalendarCore />
}
