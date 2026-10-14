import type { PubItem } from '@web/components/PublishDialog/publishDialog.type'

export interface IPlatsParamsRef {}

export interface IPlatsParamsProps {
  pubItem: PubItem
  // 是否为移动端
  isMobile?: boolean
}
