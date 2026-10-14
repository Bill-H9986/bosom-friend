/**
 * 发布弹框相关的模态框组件集合
 * 包含抖音扫码、发布详情等弹窗
 */

import { memo } from 'react'
import { DouyinQRCodeModal } from '@web/components/PublishDialog/compoents/DouyinQRCodeModal'

interface PublishModalsProps {
  // 抖音扫码弹窗
  douyinQRCodeVisible: boolean
  setDouyinQRCodeVisible: (visible: boolean) => void
  douyinPermalink: string
  // 发布详情弹框
  publishDetailVisible: boolean
  onPublishDetailClose: () => void
  currentPublishTaskId: string | undefined
  // 发布完成后是否自动关闭弹框
  autoCloseOnComplete?: boolean
}

/**
 * 发布弹框相关的模态框组件集合
 */
export const PublishModals = memo(
  ({
    douyinQRCodeVisible,
    setDouyinQRCodeVisible,
    douyinPermalink,
    publishDetailVisible,
    onPublishDetailClose,
    currentPublishTaskId,
    autoCloseOnComplete,
  }: PublishModalsProps) => {
    return (
      <>

        {/* 抖音扫码发布弹窗 */}
        {douyinQRCodeVisible && (
          <DouyinQRCodeModal
            open={douyinQRCodeVisible}
            permalink={douyinPermalink}
            onClose={() => setDouyinQRCodeVisible(false)}
          />
        )}

        {/* 发布状态弹框已按要求移除（2026-09-29）：它只显示「平台发布失败」四个字，
            还会拿另一条失败记录来误导（实测：明明有作品 ID 已写回记录，弹框仍显示失败）。
            发布过程与结果一律在聊天卡片里如实呈现。 */}
      </>
    )
  },
)

PublishModals.displayName = 'PublishModals'

export default PublishModals
