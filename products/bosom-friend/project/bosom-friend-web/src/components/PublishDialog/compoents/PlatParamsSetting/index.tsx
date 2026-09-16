/**
 * PlatParamsSetting - 平台参数设置组件
 * 根据平台类型显示对应的参数设置表单
 */
import type { CSSProperties, ForwardedRef } from 'react'
import type { PubItem } from '@web/components/PublishDialog/publishDialog.type'
import { forwardRef, memo, useMemo } from 'react'

import { useShallow } from 'zustand/react/shallow'
import { PlatType } from '@web/app/config/platConfig'
import { useTransClient } from '@web/app/i18n/client'
import { PlatformIcon } from '@web/components/common/PlatformIcon'
import BilibParams from '@web/components/PublishDialog/compoents/PlatParamsSetting/plats/BilibParams'
import KwaiParams from '@web/components/PublishDialog/compoents/PlatParamsSetting/plats/KwaiParams'
import WxGzhParams from '@web/components/PublishDialog/compoents/PlatParamsSetting/plats/WxGzhParams'
import { usePublishDialog } from '@web/components/PublishDialog/usePublishDialog'
import { usePlatformInfo } from '@web/hooks/usePlatformMetadata'
import { cn } from '@web/utils/className'
import DouyinParams from './plats/DouyinParams'
import WxSphParams from './plats/WxSphParams'
import XhsParams from './plats/XhsParams'

export interface IPlatParamsSettingRef {}

export interface IPlatParamsSettingProps {
  pubItem: PubItem
  style?: CSSProperties
  // 是否为移动端
  isMobile?: boolean
}

const PlatParamsSetting = memo(
  forwardRef(
    (
      { pubItem, style, isMobile }: IPlatParamsSettingProps,
      ref: ForwardedRef<IPlatParamsSettingRef>,
    ) => {
      const { expandedPubItem, step, setExpandedPubItem } = usePublishDialog(
        useShallow(state => ({
          expandedPubItem: state.expandedPubItem,
          step: state.step,
          setExpandedPubItem: state.setExpandedPubItem,
        })),
      )
      const { t } = useTransClient('publish')
      const platConfig = usePlatformInfo(pubItem.account.type)

      const PlatItemComp = useMemo(() => {
        switch (pubItem.account.type) {
          case PlatType.KWAI:
            return (
              <KwaiParams pubItem={pubItem} isMobile={isMobile} />
            )
          case PlatType.BILIBILI:
            return (
              <BilibParams pubItem={pubItem} isMobile={isMobile} />
            )
          case PlatType.WxGzh:
            return (
              <WxGzhParams pubItem={pubItem} isMobile={isMobile} />
            )
          case PlatType.Douyin:
            return (
              <DouyinParams pubItem={pubItem} isMobile={isMobile} />
            )
          case PlatType.Xhs:
            return (
              <XhsParams pubItem={pubItem} isMobile={isMobile} />
            )
          case PlatType.WxSph:
            return (
              <WxSphParams pubItem={pubItem} isMobile={isMobile} />
            )
          default:
            // 国际平台（TikTok/YouTube/Facebook 等）无专用参数面板：
            // 不渲染快手表单，避免平台字段语义错配（标题/描述/话题由通用参数区处理）
            return null
        }
      }, [pubItem, isMobile])

      // true=展开当前账号的参数设置 false=不展开
      const isExpand = useMemo(() => {
        if (step === 0)
          return true
        return expandedPubItem?.account.id === pubItem.account.id
      }, [expandedPubItem, pubItem, step])

      // 检查描述是否超过最大长度
      const isTextOverflow = Boolean(platConfig && platConfig.commonPubParamsConfig.desMax < pubItem.params.des.length)

      return (
        <div
          className={cn(!isExpand && 'flex items-center')}
          onClick={e => e.stopPropagation()}
          style={style}
        >
          <div className="flex w-full min-w-0">
            {/* 平台图标 */}
            <div className="mt-[5px] mr-2.5 shrink-0">
              <PlatformIcon
                platform={pubItem.account.type}
                className="w-[25px] h-[25px] rounded-full"
                width={25}
                height={25}
              />
            </div>

            {isExpand ? (
              PlatItemComp
            ) : (
              <div
                className={cn(
                  'w-full min-w-0 border border-border rounded h-10',
                  'cursor-pointer flex items-center px-4 text-foreground',
                  'hover:border-primary/50 transition-colors',
                )}
                onClick={() => {
                  setExpandedPubItem(pubItem)
                }}
              >
                <p
                  className={cn(
                    'whitespace-nowrap overflow-hidden text-ellipsis',
                    isTextOverflow && 'bg-destructive/10',
                  )}
                >
                  {pubItem.params.des ? (
                    pubItem.params.des
                  ) : (
                    <span className="text-muted-foreground">
                      {t('form.descriptionPlaceholder')}
                      ...
                    </span>
                  )}
                </p>
              </div>
            )}
          </div>
        </div>
      )
    },
  ),
)

export default PlatParamsSetting
