import { useCallback } from 'react'
import { usePublishDialogHostStore } from '@web/store/publishDialogHost'
import type { PublishDialogOpenParams } from '@web/store/publishDialogHost'
import PublishDialog from './index'

/**
 * 全应用唯一的发布弹窗宿主：挂在布局壳（WebAppLayout）里，只渲染一次。
 * 各页面通过 openPublishDialog(...) 打开它，不再各自挂载与维护开关状态。
 */
export function PublishDialogHost() {
  const open = usePublishDialogHostStore(state => state.open)
  const params = usePublishDialogHostStore(state => state.params)
  const closePublish = usePublishDialogHostStore(state => state.closePublish)
  const bindDialogRef = usePublishDialogHostStore(state => state.bindDialogRef)

  const active: PublishDialogOpenParams = params ?? { accounts: [] }
  const { onClosed, ...dialogProps } = active
  const handleClose = useCallback(() => {
    closePublish()
    onClosed?.()
  }, [closePublish, onClosed])

  return (
    <PublishDialog
      {...dialogProps}
      open={open}
      onClose={handleClose}
      ref={bindDialogRef}
    />
  )
}

export default PublishDialogHost
