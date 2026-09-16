/**
 * 全局监控页（从账号管理拆分为独立页面）。
 * 渲染自动接待全局监控组件；入口位于左侧导航与账号管理页入口卡片。
 */
import dynamic from '@web/next-shims/dynamic'

const GlobalMonitorCore = dynamic(() => import('@/views/reception/components/GlobalMonitor'), {
  loading: null,
})

export default function MonitorPage() {
  return <GlobalMonitorCore />
}
