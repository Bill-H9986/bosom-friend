import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import usePubParamsVerify from '@web/components/PublishDialog/hooks/usePubParamsVerify'
import { usePublishDialog } from '@web/components/PublishDialog/usePublishDialog'
import { toast } from '@web/utils/ui/toast'

export function useValidatedPublishTrigger(onPublish: () => void) {
  const { step, pubListChoosed, setExpandedPubItem } = usePublishDialog(
    useShallow(state => ({
      step: state.step,
      pubListChoosed: state.pubListChoosed,
      setExpandedPubItem: state.setExpandedPubItem,
    })),
  )
  const { errParamsMap } = usePubParamsVerify(pubListChoosed)

  const triggerPublish = useCallback((silent: boolean | string = false) => {
    const isSilent = silent === true
    if (errParamsMap) {
      for (const [key, errVideoItem] of errParamsMap) {
        if (!errVideoItem)
          continue

        const pubItem = pubListChoosed.find(v => v.account.id === key)
        if (pubItem && step === 1)
          setExpandedPubItem(pubItem)

        if (errVideoItem.parErrMsg && !isSilent)
          toast.warning(errVideoItem.parErrMsg)

        return false
      }
    }

    onPublish()
    return true
  }, [errParamsMap, onPublish, pubListChoosed, setExpandedPubItem, step])

  return {
    triggerPublish,
  }
}
