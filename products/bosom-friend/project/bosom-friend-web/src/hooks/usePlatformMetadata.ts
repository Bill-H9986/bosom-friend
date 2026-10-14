'use client'

import type { PlatType } from '@web/app/config/platConfig'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { useGetClientLng } from '@web/hooks/useSystem'
import { useAccountStore } from '@web/store/account'
import { usePlatformMetadataStore } from '@web/store/platformMetadata'
import {
  getChannelPlatformInfos,
  getEnabledPlatformInfos,
  getPublishPlatformInfos,
  getTaskChannelPlatformInfos,
  platformInfoListToTuples,
} from '@web/store/platformMetadata/utils'

export function usePlatformMetadata() {
  const lng = useGetClientLng()
  const { list, map, status, ensureLoaded } = usePlatformMetadataStore(
    useShallow(state => ({
      list: state.list,
      map: state.map,
      status: state.status,
      ensureLoaded: state.ensureLoaded,
    })),
  )

  useEffect(() => {
    ensureLoaded(lng)
  }, [ensureLoaded, lng])

  return {
    list,
    map,
    status,
    ready: status === 'success',
  }
}

export function usePlatformMetadataReady() {
  const status = usePlatformMetadataStore(state => state.status)
  const lng = useGetClientLng()
  const ensureLoaded = usePlatformMetadataStore(state => state.ensureLoaded)

  useEffect(() => {
    ensureLoaded(lng)
  }, [ensureLoaded, lng])

  return status === 'success'
}

export function usePlatformInfo(platType?: PlatType | null) {
  const map = usePlatformMetadataStore(state => state.map)
  const lng = useGetClientLng()
  const ensureLoaded = usePlatformMetadataStore(state => state.ensureLoaded)

  useEffect(() => {
    ensureLoaded(lng)
  }, [ensureLoaded, lng])

  return platType ? map.get(platType) : undefined
}

export function usePlatformInfoMap() {
  usePlatformMetadata()
  return usePlatformMetadataStore(state => state.map)
}

export function usePlatformInfoList(scene: 'all' | 'enabled' | 'publish' | 'task' = 'all') {
  const { list } = usePlatformMetadata()

  if (scene === 'enabled')
    return getEnabledPlatformInfos(list)
  if (scene === 'publish')
    return getPublishPlatformInfos(list)
  if (scene === 'task')
    return getTaskChannelPlatformInfos(list)
  return list
}

export function useRegionSortedPlatforms() {
  const { list } = usePlatformMetadata()
  return platformInfoListToTuples(getChannelPlatformInfos(list))
}

/**
 * 内容创作可用平台：与「添加频道」页面的平台清单对齐。
 *
 * 只列出产品真实接通授权的频道平台（小红书 / 抖音 / 快手）——引擎有定义但没接通授权的
 * 平台不出现，避免用户选了目标平台却根本发不出去。已连接账号的平台排在前面，
 * 尚未连接的平台保留在后面（选中发布时会引导去添加频道）。
 *
 * @returns [平台类型, 平台信息] 元组数组，供选择器与参数限制使用。
 */
export function useTaskPlatforms() {
  const { list } = usePlatformMetadata()
  const accountList = useAccountStore(state => state.accountList)
  const connected = new Set(accountList.map(account => account.type))
  const channelPlatforms = getTaskChannelPlatformInfos(list)
  return platformInfoListToTuples([
    ...channelPlatforms.filter(item => connected.has(item.type)),
    ...channelPlatforms.filter(item => !connected.has(item.type)),
  ])
}

export function useFreshTaskPlatforms() {
  const lng = useGetClientLng()
  const { list, loadedLng, status, ensureLoaded } = usePlatformMetadataStore(
    useShallow(state => ({
      list: state.list,
      loadedLng: state.loadedLng,
      status: state.status,
      ensureLoaded: state.ensureLoaded,
    })),
  )
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timeout = setTimeout(() => {
      if (!cancelled)
        setReady(true)
    }, 3000)

    if (loadedLng !== lng && list.length === 0)
      setReady(false)
    else
      setReady(true)

    ensureLoaded(lng, { force: true }).then(() => {
      if (!cancelled)
        setReady(true)
    }).finally(() => {
      clearTimeout(timeout)
    })
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [ensureLoaded, list.length, loadedLng, lng])

  return {
    platforms: platformInfoListToTuples(getTaskChannelPlatformInfos(list)),
    ready: ready || list.length > 0 || status === 'error',
  }
}

export function usePlatformName(platType?: PlatType | null, fallback?: string) {
  const platformInfo = usePlatformInfo(platType)
  return platformInfo?.name ?? fallback ?? platType ?? ''
}
