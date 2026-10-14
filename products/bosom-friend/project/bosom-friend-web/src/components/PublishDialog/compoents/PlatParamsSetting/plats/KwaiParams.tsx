import type { ForwardedRef } from 'react'
import type {
  IPlatsParamsProps,
  IPlatsParamsRef,
} from '@web/components/PublishDialog/compoents/PlatParamsSetting/plats/plats.type'
import { forwardRef, memo } from 'react'
import usePlatParamsCommon from '@web/components/PublishDialog/compoents/PlatParamsSetting/hooks/usePlatParamsCoomon'
import PubParmasTextarea from '@web/components/PublishDialog/compoents/PubParmasTextarea'

const KwaiParams = memo(
  forwardRef(
    (
      { pubItem, isMobile }: IPlatsParamsProps,
      ref: ForwardedRef<IPlatsParamsRef>,
    ) => {
      const { pubParmasTextareaCommonParams } = usePlatParamsCommon(
        pubItem,
        isMobile,
      )

      return (
        <>
          <PubParmasTextarea {...pubParmasTextareaCommonParams} />
        </>
      )
    },
  ),
)

export default KwaiParams
