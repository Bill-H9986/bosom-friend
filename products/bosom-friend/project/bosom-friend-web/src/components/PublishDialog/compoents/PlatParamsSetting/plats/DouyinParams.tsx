import type { ForwardedRef } from 'react'
import type {
  IPlatsParamsProps,
  IPlatsParamsRef,
} from '@web/components/PublishDialog/compoents/PlatParamsSetting/plats/plats.type'
import { forwardRef, memo } from 'react'
import CommonTitleInput from '@web/components/PublishDialog/compoents/PlatParamsSetting/common/CommonTitleInput'
import usePlatParamsCommon from '@web/components/PublishDialog/compoents/PlatParamsSetting/hooks/usePlatParamsCoomon'
import PubParmasTextarea from '@web/components/PublishDialog/compoents/PubParmasTextarea'
import { usePublishDialog } from '@web/components/PublishDialog/usePublishDialog'
import { Input } from '@web/components/ui/input'
import { cn } from '@web/utils/className'

const DouyinParams = memo(
  forwardRef(
    (
      { pubItem, isMobile }: IPlatsParamsProps,
      ref: ForwardedRef<IPlatsParamsRef>,
    ) => {
      const { pubParmasTextareaCommonParams } = usePlatParamsCommon(
        pubItem,
        isMobile,
      )
      const setOnePubParams = usePublishDialog(state => state.setOnePubParams)
      // 位置只在「抖音 + 视频」露出：引擎侧 --location 只被 douyin/upload-video 注册，
      // 图文或别的平台填了也不生效（DEF-235），不该让用户白填。
      const showLocation = pubItem.params.video !== undefined

      return (
        <>
          <PubParmasTextarea
            {...pubParmasTextareaCommonParams}
            extend={<CommonTitleInput pubItem={pubItem} isMobile={isMobile} />}
          />
          {showLocation && (
            <div className={cn('flex', isMobile ? 'flex-col gap-1.5' : 'items-center h-8 mt-2')}>
              <div className={cn('shrink-0', isMobile ? 'text-sm font-medium' : 'w-[90px] mr-2.5')}>
                位置
              </div>
              <Input
                value={pubItem.params.location || ''}
                maxLength={30}
                placeholder="抖音视频可加一个位置标签，如：重庆"
                className="h-8 flex-1"
                onChange={e => setOnePubParams({ location: e.target.value }, pubItem.account.id)}
              />
            </div>
          )}
        </>
      )
    },
  ),
)

export default DouyinParams
