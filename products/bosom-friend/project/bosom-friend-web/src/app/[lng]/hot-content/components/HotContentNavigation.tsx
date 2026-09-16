'use client'

import { ChevronDown, Loader2, RotateCcw, Search } from 'lucide-react'
import Link from '@web/next-shims/link'
import { usePathname, useRouter } from '@web/next-shims/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTransClient } from '@web/app/i18n/client'
import { PageShell } from '@web/app/layout/PageShell'
import { Button } from '@web/components/ui/button'
import { resolveAsset } from '@web/utils/assetPath'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@web/components/ui/command'
import { Dialog, DialogContent } from '@web/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu'
import { useGetClientLng } from '@web/hooks/useSystem'
import { cn } from '@web/utils/className'
import {
  searchHotContentSources,
  HotContentSearchStatus,
  useHotContentCategories,
} from '../api'
import type { HotContentCategory, HotContentSearchStatusValue } from '../api'

function isHomePath(pathname: string) {
  return /\/hot-content\/?$/.test(pathname)
}

function isCategoryPath(pathname: string, cid: string | number) {
  return pathname.includes(`/hot-content/category/${cid}`)
}

function MoreCategoriesDropdown({ categories, pathname }: {
  categories: HotContentCategory[]
  pathname: string
}) {
  const { ready, t } = useTransClient('hotContent')
  const lng = useGetClientLng()
  const active = categories.some(category => isCategoryPath(pathname, category.cid))

  if (!ready || categories.length === 0)
    return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-testid="hot-content-navigation-more"
          type="button"
          className={cn(
            'page-tab',
            active ? 'page-tab-active' : 'page-tab-idle',
          )}
        >
          {t('navigation.more')}
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {categories.map(category => (
          <DropdownMenuItem key={category.cid} asChild>
            <Link
              data-testid={`hot-content-navigation-more-category-${category.cid}`}
              href={`/${lng}/hot-content/category/${category.cid}`}
              className={cn(
                'cursor-pointer',
                isCategoryPath(pathname, category.cid) && 'bg-accent text-foreground',
              )}
            >
              {category.name}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HotContentSearchDialog({ categories, open, onOpenChange }: {
  categories: HotContentCategory[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { ready, t } = useTransClient('hotContent')
  const lng = useGetClientLng()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{
    cid?: number
    display: string
    iconUrl?: string
    name: string
    sourceKey: string
  }>>([])
  const [searchStatus, setSearchStatus] = useState<HotContentSearchStatusValue>(HotContentSearchStatus.Idle)
  const [retryTick, setRetryTick] = useState(0)
  const categoryNames = new Map(categories.map(({ cid, name }) => [cid, name]))

  useEffect(() => {
    const keyword = query.trim()
    if (!open || keyword.length < 2) {
      setResults([])
      setSearchStatus(HotContentSearchStatus.Idle)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setSearchStatus(HotContentSearchStatus.Loading)
      searchHotContentSources(keyword, controller.signal)
        .then((data) => {
          if (controller.signal.aborted)
            return
          const hasResults = data.list.length > 0
          setResults(data.list)
          setSearchStatus(hasResults
            ? HotContentSearchStatus.Success
            : HotContentSearchStatus.Empty)
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setResults([])
            setSearchStatus(HotContentSearchStatus.Error)
          }
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [open, query, retryTick])

  if (!ready)
    return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="top-2 h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-none translate-y-0 gap-0 overflow-hidden p-0 sm:top-1/2 sm:h-auto sm:max-w-2xl sm:-translate-y-1/2"
      >
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <CommandInput
            data-testid="hot-content-search-input"
            value={query}
            onValueChange={(value) => {
              const trimmed = value.trim()
              setQuery(value)
              setResults([])
              setSearchStatus(trimmed.length >= 2
                ? HotContentSearchStatus.Loading
                : HotContentSearchStatus.Idle)
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.inputLabel')}
          />
          <CommandList className="max-h-[calc(100dvh-5rem)] sm:max-h-[32rem]">
        {searchStatus === HotContentSearchStatus.Idle && (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <Search className="size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium text-foreground">
              {t('search.idleTitle')}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t('search.idleDescription')}
            </p>
          </div>
        )}
        {searchStatus === HotContentSearchStatus.Loading && (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            {t('search.loading')}
          </div>
        )}
        {searchStatus === HotContentSearchStatus.Empty && (
          <div className="px-6 py-16 text-center">
            <p className="text-sm font-medium text-foreground">
              {t('search.emptyTitle')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('search.emptyDescription')}
            </p>
          </div>
        )}
        {searchStatus === HotContentSearchStatus.Error && (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <p className="text-sm font-medium text-foreground">
              {t('search.errorTitle')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('search.errorDescription')}
            </p>
            <Button
              data-testid="hot-content-search-retry"
              type="button"
              variant="outline"
              size="sm"
              className="mt-4 cursor-pointer"
              onClick={() => setRetryTick(tick => tick + 1)}
            >
              <RotateCcw className="size-3.5" />
              {t('common:retry')}
            </Button>
          </div>
        )}
        {searchStatus === HotContentSearchStatus.Success && (
          <CommandGroup heading={t('search.results', { count: results.length })}>
            {results.map(({ cid, display, iconUrl, name, sourceKey }) => (
              <CommandItem
                key={sourceKey}
                data-testid={`hot-content-search-result-${sourceKey}`}
                value={sourceKey}
                className="cursor-pointer py-2.5"
                onSelect={() => {
                  onOpenChange(false)
                  router.push(`/${lng}/hot-content/source/${sourceKey}`)
                }}
              >
                <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/60">
                  {iconUrl
                    ? (
                        <img
                      src={resolveAsset(iconUrl)}
                          alt=""
                          width={36}
                          height={36}
                          loading="lazy"
                          className="size-full object-contain"
                        />
                      )
                    : (
                        <span className="text-xs font-semibold text-muted-foreground">
                          {name.slice(0, 1)}
                        </span>
                      )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium text-foreground">
                      {name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {display}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {cid ? categoryNames.get(cid) ?? cid : ''}
                  </p>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}

export function HotContentNavigation({ children, hideTabs = false }: { children?: ReactNode, hideTabs?: boolean }) {
  const router = useRouter()
  const pathname = usePathname()
  const { ready, t } = useTransClient(['hotContent', 'route'])
  const lng = useGetClientLng()
  const { categories, isLoading } = useHotContentCategories()
  const [searchOpen, setSearchOpen] = useState(false)
  const visibleCategories = hideTabs ? [] : categories.slice(0, 7)
  const moreCategories = categories.slice(7)
  const activeCategory = hideTabs ? undefined : categories.find(category => isCategoryPath(pathname, category.cid))

  if (!ready || isLoading)
    return <div className="h-14 border-b border-border/60 bg-background/95" />

  return (
    <PageShell
      tabs={visibleCategories.map(category => ({ key: String(category.cid), label: category.name }))}
      activeTab={activeCategory ? String(activeCategory.cid) : undefined}
      onTabChange={(key) => {
        router.push(`/${lng}/hot-content/category/${key}`)
      }}
      tabExtra={<MoreCategoriesDropdown categories={moreCategories} pathname={pathname} />}
      actions={(
        <Button
          data-testid="hot-content-search-trigger"
          type="button"
          variant="outline"
          size="sm"
          className="h-8 cursor-pointer rounded-lg px-2.5 text-sm xl:min-w-52 xl:justify-start xl:px-4"
          onClick={() => setSearchOpen(true)}
          aria-label={t('search.open')}
        >
          <Search className="size-4" />
          <span className="hidden xl:inline">{t('search.open')}</span>
        </Button>
      )}
      contentClassName="p-0"
    >
      <HotContentSearchDialog
        categories={categories}
        open={searchOpen}
        onOpenChange={setSearchOpen}
      />
      {children}
    </PageShell>
  )
}
