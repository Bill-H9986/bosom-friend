import type { PublishOptionValueItem } from '@web/api/channels/channel.types'
import type {
  BiblPartItem,
} from '@web/components/PublishDialog/publishDialog.type'
import lodash from 'lodash'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'

export interface IPublishDialogDataStore {
  // b站分区列表
  bilibiliPartitions: BiblPartItem[]
  // b站分区加载状态
  bilibiliPartitionsLoading: boolean
}

const store: IPublishDialogDataStore = {
  bilibiliPartitions: [],
  bilibiliPartitionsLoading: false,
}

function getStore() {
  return lodash.cloneDeep(store)
}

/**
 * 存放发布弹框一些平台获取的三方数据
 * 如：b站的分区列表
 */
export const usePublishDialogData = create(
  combine(
    {
      ...getStore(),
    },
    (set, get, storeApi) => {
      const methods = {
        // 获取b站分区列表
        async getBilibiliPartitions() {
          if (get().bilibiliPartitions.length !== 0)
            return get().bilibiliPartitions
          if (get().bilibiliPartitionsLoading)
            return get().bilibiliPartitions

          set({ bilibiliPartitionsLoading: true })
          try {
            // B站平台已下线，分区列表不再从后端拉取，返回空列表
            const partitions: never[] = []
            set({
              bilibiliPartitions: partitions,
            })
            return partitions
          }
          finally {
            set({ bilibiliPartitionsLoading: false })
          }
        },
      }

      return methods
    },
  ),
)
