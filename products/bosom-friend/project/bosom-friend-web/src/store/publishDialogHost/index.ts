import { create } from 'zustand'
import type { IPublishDialogProps, IPublishDialogRef } from '@web/components/PublishDialog'

/** 打开发布弹窗需要的参数；`open`/`onClose` 由唯一宿主负责，调用方不传。 */
export type PublishDialogOpenParams = Omit<IPublishDialogProps, 'open' | 'onClose'> & {
  /** 弹窗关闭后的页面清理（宿主不透给弹窗组件）。 */
  onClosed?: () => void
}

interface PublishDialogHostState {
  open: boolean
  params: PublishDialogOpenParams | null
  dialogRef: IPublishDialogRef | null
  openPublish: (params: PublishDialogOpenParams) => void
  closePublish: () => void
  bindDialogRef: (ref: IPublishDialogRef | null) => void
}

/**
 * 全应用唯一的发布弹窗宿主状态。
 *
 * 此前「内容创作 / 账号日历 / AI 批量工具条」各自挂载一份 <PublishDialog>，
 * 同时各管一套开关状态与账号列表，同一个弹窗实现了三遍；现在统一由布局壳挂一个宿主，
 * 入口只调 openPublishDialog()，状态只有这一份。
 */
export const usePublishDialogHostStore = create<PublishDialogHostState>(set => ({
  open: false,
  params: null,
  dialogRef: null,
  openPublish: params => set({ open: true, params }),
  closePublish: () => set({ open: false }),
  bindDialogRef: ref => set({ dialogRef: ref }),
}))

/**
 * 打开发布弹窗（全应用唯一入口）。
 *
 * @param params - 弹窗参数，另支持 onClosed 做关闭后的页面清理。
 */
export function openPublishDialog(params: PublishDialogOpenParams): void {
  usePublishDialogHostStore.getState().openPublish(params)
}

/**
 * 取宿主实例的命令式句柄（日历页「新建作品」用它预设发布时间）。
 *
 * @returns 弹窗句柄；宿主尚未挂载时为 null。
 */
export function publishDialogHandle(): IPublishDialogRef | null {
  return usePublishDialogHostStore.getState().dialogRef
}
