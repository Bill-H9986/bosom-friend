'use client'

import { useEffect, useRef } from 'react'

interface EChartProps {
  option: Record<string, unknown>
  className?: string
  testId?: string
  onDataClick?: (index: number) => void
}

export function EChart({ option, className, testId, onDataClick }: EChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<{ dispose: () => void; resize: () => void } | null>(null)
  const clickHandlerRef = useRef(onDataClick)
  clickHandlerRef.current = onDataClick

  useEffect(() => {
    let disposed = false
    let chart: any = null
    let onResize: (() => void) | null = null
    let onClick: ((params: any) => void) | null = null

    import('echarts').then(({ init }) => {
      if (disposed || !containerRef.current)
        return
      chart = init(containerRef.current)
      chartRef.current = chart
      chart.setOption(option)
      onResize = () => chart.resize()
      window.addEventListener('resize', onResize)
      onClick = (params: any) => {
        if (typeof params?.dataIndex === 'number')
          clickHandlerRef.current?.(params.dataIndex)
      }
      chart.on('click', onClick)
    })

    return () => {
      disposed = true
      if (onResize)
        window.removeEventListener('resize', onResize)
      if (onClick && chart)
        chart.off('click', onClick)
      chartRef.current?.dispose()
      chartRef.current = null
    }
  }, [option])

  return <div ref={containerRef} className={className} data-testid={testId} />
}
