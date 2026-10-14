import type { PlatformInfo, PlatformMetadataVo } from '@web/api/channels/channel.types'
import { PlatType } from '@web/app/config/platConfig'
import { PlatformStatus } from '@web/api/channels/channel.constants'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import { getChannelPlatformsApi } from '@web/api/channels/channel.api'
import { getStaticPlatformIcon } from '@web/store/platformMetadata/staticIcons'
import { resolveAsset } from '@web/utils/assetPath'
import {
  getChannelPlatformInfos,
  getEnabledPlatformInfos,
  getPublishPlatformInfos,
  getTaskPlatformInfos,
  isPlatCollectSupported,
  isPlatformAvailable,
  isPlatformComingSoon,
  isPlatViewSupported,
  isTaskPlatformSupported,
  normalizePlatformMetadataList,
} from '@web/store/platformMetadata/utils'

type PlatformMetadataStatus = 'idle' | 'loading' | 'success' | 'error'

interface PlatformMetadataState {
  rawList: PlatformMetadataVo[]
  list: PlatformInfo[]
  map: Map<PlatType, PlatformInfo>
  status: PlatformMetadataStatus
  loadedLng?: string
  errorMessage?: string
}

const initialState: PlatformMetadataState = {
  rawList: [],
  list: [],
  map: new Map(),
  status: 'idle',
  loadedLng: undefined,
  errorMessage: undefined,
}

let latestRequestedLng: string | undefined
let latestFetchVersion = 0

/**
 * 桌面端平台元数据兜底：后端列表缺少抖音时补一个可用配置，
 * 保证本地账号授权（扫码）与发布链路能识别抖音平台。
 */
function createFallbackDouyinVo(): PlatformMetadataVo {
  return {
    platform: PlatType.Douyin,
    status: PlatformStatus.Available,
    displayName: { 'zh-CN': '抖音' } as PlatformMetadataVo['displayName'],
    logoUrl: resolveAsset(getStaticPlatformIcon(PlatType.Douyin)) || '',
    authType: 'qrcode',
    editor: 'normal',
    contentLimits: { modes: ['video', 'image_text'] },
    mediaRules: {},
    topic: { supported: true },
    capabilities: {
      auth: {},
      publish: { supported: true },
      analytics: {},
      engagement: {},
      work: {},
      browse: {},
      webhook: {},
    },
    optionSchema: {},
  } as PlatformMetadataVo
}

function ensureDouyinFallback(rawList: PlatformMetadataVo[]): PlatformMetadataVo[] {
  const isDesktop = typeof window !== 'undefined' && !!window.ipcRenderer
  if (!isDesktop)
    return rawList
  if (rawList.some(item => item.platform === PlatType.Douyin))
    return rawList
  return [...rawList, createFallbackDouyinVo()]
}

async function fetchPlatformMetadata(options?: { fresh?: boolean }) {
  try {
    const res = await getChannelPlatformsApi(options)
    if (Number(res?.code) !== 0 || !res?.data) {
      return {
        rawList: undefined,
        errorMessage: res?.message,
      }
    }
    return {
      rawList: res.data,
      errorMessage: undefined,
    }
  }
  catch (error: unknown) {
    return {
      rawList: undefined,
      errorMessage: error instanceof Error ? error.message : undefined,
    }
  }
}

let pendingRequest: Promise<Awaited<ReturnType<typeof fetchPlatformMetadata>>> | null = null

function createPlatformMetadataRequest(options?: { fresh?: boolean }) {
  const version = ++latestFetchVersion
  const request = fetchPlatformMetadata(options).finally(() => {
    if (pendingRequest === request)
      pendingRequest = null
  })
  pendingRequest = request

  return { request, version }
}

function createPlatformMetadataState(rawList: PlatformMetadataVo[], lng: string): PlatformMetadataState {
  const { list, map } = normalizePlatformMetadataList(rawList, lng)

  if (typeof window !== 'undefined') {
    console.info('[PlatformMetadata] initialized', {
      lng,
      rawList,
      list,
    })
  }

  return {
    rawList,
    list,
    map,
    status: 'success',
    loadedLng: lng,
    errorMessage: undefined,
  }
}

export const usePlatformMetadataStore = create(
  combine(initialState, (set, get) => ({
    async ensureLoaded(lng: string, options?: { force?: boolean }) {
      latestRequestedLng = lng
      const force = options?.force === true
      const state = get()
      if (!force && state.status === 'success' && state.loadedLng === lng)
        return true
      if (!force && state.rawList.length > 0) {
        set(createPlatformMetadataState(ensureDouyinFallback(state.rawList), lng))
        return true
      }

      let request = pendingRequest
      let version = latestFetchVersion

      if (force) {
        ;({ request, version } = createPlatformMetadataRequest({ fresh: true }))
      }
      else if (!request) {
        set({ status: 'loading', errorMessage: undefined })
        ;({ request, version } = createPlatformMetadataRequest())
      }

      const { rawList, errorMessage } = await request!
      if (!rawList) {
        if (version === latestFetchVersion) {
          set({
            status: 'error',
            errorMessage,
          })
        }
        return false
      }

      if (version !== latestFetchVersion || latestRequestedLng !== lng)
        return false

      set(createPlatformMetadataState(ensureDouyinFallback(rawList), lng))

      return true
    },
  })),
)

export function getPlatformInfoSync(platType?: PlatType | null) {
  if (!platType)
    return undefined
  return usePlatformMetadataStore.getState().map.get(platType)
}

export function getPlatformInfoMapSync() {
  return usePlatformMetadataStore.getState().map
}

export function getPlatformInfoListSync() {
  return usePlatformMetadataStore.getState().list
}

export function getEnabledPlatformInfosSync() {
  return getEnabledPlatformInfos(usePlatformMetadataStore.getState().list)
}

export function getChannelPlatformInfosSync() {
  return getChannelPlatformInfos(usePlatformMetadataStore.getState().list)
}

export function getPublishPlatformInfosSync() {
  return getPublishPlatformInfos(usePlatformMetadataStore.getState().list)
}

export function getTaskPlatformInfosSync() {
  return getTaskPlatformInfos(usePlatformMetadataStore.getState().list)
}

export function isPlatformMetadataReadySync() {
  return usePlatformMetadataStore.getState().status === 'success'
}

export function isPlatformEnabledSync(platType?: PlatType | null) {
  const platformInfo = getPlatformInfoSync(platType)
  return isPlatformAvailable(platformInfo)
}

export function isPlatformDisabledSync(platType?: PlatType | null) {
  const platformInfo = getPlatformInfoSync(platType)
  return isPlatformComingSoon(platformInfo)
}

export {
  isPlatCollectSupported,
  isPlatViewSupported,
  isTaskPlatformSupported,
}
