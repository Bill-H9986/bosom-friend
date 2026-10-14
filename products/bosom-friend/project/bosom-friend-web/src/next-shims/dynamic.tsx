import { ComponentType, LazyExoticComponent, lazy, Suspense } from 'react'

interface DynamicOptions {
  loading?: ComponentType<Record<string, unknown>> | null
  ssr?: boolean
}

export default function dynamic(
  loader: () => Promise<{ default: ComponentType } | ComponentType>,
  options: DynamicOptions = {},
) {
  const LazyComponent: LazyExoticComponent<ComponentType> = lazy(async () => {
    const mod = await loader()
    const Cmp = (mod as { default?: ComponentType }).default ?? (mod as ComponentType)
    return { default: Cmp }
  })

  const Loading = options.loading ?? null

  function DynamicWrapper(props: Record<string, unknown>) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        <LazyComponent {...props} />
      </Suspense>
    )
  }

  return DynamicWrapper
}
