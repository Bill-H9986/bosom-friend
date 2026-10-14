'use client'

import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'

export function HotContentRouteError({ reset }: { reset?: () => void }) {
  const { ready, t } = useTransClient('hotContent')

  if (!ready)
    return <div className="min-h-80" />

  return (
    <div className="mx-auto flex min-h-96 w-full max-w-[1600px] flex-col items-center justify-center px-4 text-center md:px-6">
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-5" />
      </div>
      <h1 className="mt-4 text-base font-semibold text-foreground">
        {t('error.title')}
      </h1>
      <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
        {t('error.description')}
      </p>
      <Button
        data-testid="hot-content-route-retry"
        type="button"
        variant="outline"
        size="sm"
        className="mt-5 cursor-pointer"
        onClick={reset}
      >
        <RotateCcw className="size-4" />
        {t('common:retry')}
      </Button>
    </div>
  )
}
