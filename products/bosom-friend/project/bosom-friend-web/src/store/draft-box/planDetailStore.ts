import type { DraftGenerationRequest, DraftGenerationTask, ImageModelType, ImageTextDraftType, VideoDraftType } from '@web/api/ai/ai.types'
import type { MaterialFilterDeleteParams, MaterialListFilters, MaterialPagination, PlanStatistics, PromotionMaterial, PromotionPlan, PublishRecord } from '@web/api/materials/material.types'
import type { PlatType } from '@web/app/config/platConfig'

import lodash from 'lodash'
import { create } from 'zustand'
import { combine } from 'zustand/middleware'
import {
  apiCreateDraftGeneration,
  apiCreateImageTextDraft,
  apiClearDraftGenerations,
  apiDeleteDraftGenerations,
  apiGetDraftGenerationList,
  apiGetDraftGenerationStats,
  apiQueryDraftGenerationTasks,
} from '@web/api/ai/ai.api'
import {
  apiBatchDeleteMaterials,
  apiDeleteMaterial,
  apiFilterDeleteMaterials,
  apiGetMaterialInfo,
  apiGetMaterialList,
} from '@web/api/materials/material.api'
import { usePublishDialogStorageStore } from '@web/components/PublishDialog/usePublishDialogStorageStore'

import { toast } from '@web/utils/ui/toast'
import {
  refreshDraftItemsInMediaTabs,
  registerPlanDetailMaterialSyncAdapter,
  removeDraftItemsFromMediaTabs,
} from './materialSync'

const DRAFT_GENERATION_QUERY_BATCH_SIZE = 10

type PublishRecordSource = string

interface BatchGenerationCreateResult {
  success: boolean
  successCount: number
  failedCount: number
  taskCount: number
  errorMessage?: string
}

interface VideoModelGenerationInput {
  modelType: string
  resolution?: string
  duration?: number
  aspectRatio?: string
}

function isDraftGenerationTaskForGroup(task: DraftGenerationTask, groupId: string) {
  return task.request?.groupId === groupId
}

function sortDraftGenerationTasks(tasks: DraftGenerationTask[]) {
  return [...tasks].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

function countGeneratingTasks(tasks: DraftGenerationTask[]) {
  return tasks.filter(task => task.status === 'generating').length
}

function mergeDraftGenerationTasks(current: DraftGenerationTask[], incoming: DraftGenerationTask[]) {
  const taskMap = new Map<string, DraftGenerationTask>()
  current.forEach(task => taskMap.set(task.id, task))
  incoming.forEach((task) => {
    const currentTask = taskMap.get(task.id)
    taskMap.set(task.id, currentTask ? { ...currentTask, ...task } : task)
  })
  return sortDraftGenerationTasks(Array.from(taskMap.values()))
}

function buildDraftGenerationTaskPlaceholder(
  id: string,
  request: DraftGenerationRequest,
): DraftGenerationTask {
  const now = new Date().toISOString()
  return {
    id,
    status: 'generating',
    points: 0,
    request,
    response: {},
    createdAt: now,
    updatedAt: now,
  }
}

function chunkTaskIds(taskIds: string[]) {
  const chunks: string[][] = []
  for (let i = 0; i < taskIds.length; i += DRAFT_GENERATION_QUERY_BATCH_SIZE) {
    chunks.push(taskIds.slice(i, i + DRAFT_GENERATION_QUERY_BATCH_SIZE))
  }
  return chunks
}

function getSettledErrorMessage(result: PromiseRejectedResult) {
  if (result.reason instanceof Error)
    return result.reason.message
  return typeof result.reason === 'string' ? result.reason : undefined
}

// Store 状态类型
export interface IPlanDetailStoreState {
  // 已初始化的 planId，用于防止重复请求
  initializedPlanId: string | null

  // 当前计划
  currentPlan: PromotionPlan | null
  planLoading: boolean

  // 素材列表
  materials: PromotionMaterial[]
  materialsLoading: boolean
  materialsInitialized: boolean
  materialsPagination: MaterialPagination

  // 发布记录
  publishRecords: PublishRecord[]
  publishRecordsLoading: boolean
  publishRecordsPagination: MaterialPagination

  // 统计数据
  statistics: PlanStatistics | null
  statisticsLoading: boolean

  // 弹窗状态
  createMaterialModalOpen: boolean
  editingMaterial: PromotionMaterial | null

  // 草稿详情弹窗状态
  draftDetailDialogOpen: boolean
  selectedDraft: PromotionMaterial | null

  // 发布弹框状态
  publishDialogOpen: boolean
  publishingDraft: PromotionMaterial | null
  publishAutoMode: boolean
  pendingAutoSyncAccountId: string | null

  // 加载状态
  isSubmitting: boolean

  // AI 批量生成
  generatingCount: number
  generationTasks: DraftGenerationTask[]
  aiBatchModalOpen: boolean
  generationDetailDialogOpen: boolean
  isGeneratingBatch: boolean

  // 搜索/筛选 & 批量操作
  materialsFilter: MaterialListFilters
  batchMode: boolean
  selectedMaterialIds: string[]
  batchDeleting: boolean
  conditionalDeleteDialogOpen: boolean

  // 数据分析数据是否已加载
  analyticsInitialized: boolean
  PublishRecordSource?: PublishRecordSource
}

// 初始状态
const initialState: IPlanDetailStoreState = {
  initializedPlanId: null,

  currentPlan: null,
  planLoading: true,

  materials: [],
  materialsLoading: true,
  materialsInitialized: false,
  materialsPagination: {
    current: 1,
    pageSize: 12,
    total: 0,
    hasMore: true,
  },

  publishRecords: [],
  publishRecordsLoading: true,
  publishRecordsPagination: {
    current: 1,
    pageSize: 10,
    total: 0,
    hasMore: true,
  },

  statistics: null,
  statisticsLoading: true,

  createMaterialModalOpen: false,
  editingMaterial: null,

  draftDetailDialogOpen: false,
  selectedDraft: null,

  publishDialogOpen: false,
  publishingDraft: null,
  publishAutoMode: false,
  pendingAutoSyncAccountId: null,

  isSubmitting: false,

  generatingCount: 0,
  generationTasks: [],
  aiBatchModalOpen: false,
  generationDetailDialogOpen: false,
  isGeneratingBatch: false,

  materialsFilter: {},
  batchMode: false,
  selectedMaterialIds: [],
  batchDeleting: false,
  conditionalDeleteDialogOpen: false,

  analyticsInitialized: false,
}

function getInitialState() {
  return lodash.cloneDeep(initialState)
}

export const usePlanDetailStore = create(
  combine(getInitialState(), (set, get) => {
    const methods = {
      // ==================== 计划详情 ====================

      /**
       * 获取计划详情
       */
      fetchPlanDetail: async (planId: string) => {
        set({ planLoading: true })
        try {
          const res = await apiGetMaterialInfo(planId)
          const plan = res?.data as PromotionPlan
          set({ currentPlan: plan })
          return plan
        }
        catch (error) {
          return null
        }
        finally {
          set({ planLoading: false })
        }
      },

      // ==================== 素材列表 ====================

      /**
       * 获取素材列表
       */
      fetchMaterials: async (planId: string, page: number = 1) => {
        set({ materialsLoading: true })
        try {
          const { materialsPagination, materialsFilter } = get()
          const res = await apiGetMaterialList(planId, page, materialsPagination.pageSize, materialsFilter)
          const resData = res?.data as { list?: any[], total?: number } | undefined
          const list = (resData?.list || []) as PromotionMaterial[]
          const total = resData?.total || 0

          set({
            materials: list,
            materialsInitialized: true,
            materialsPagination: {
              ...materialsPagination,
              current: page,
              total,
              hasMore: list.length === materialsPagination.pageSize,
            },
          })
        }
        catch (error) {
          // 错误由调用方处理
        }
        finally {
          set({ materialsLoading: false })
        }
      },

      /**
       * 加载更多素材（无限滚动）
       */
      loadMoreMaterials: async (planId: string) => {
        const { materialsLoading, materialsPagination, materials, materialsFilter } = get()
        if (materialsLoading || !materialsPagination.hasMore)
          return

        set({ materialsLoading: true })
        try {
          const nextPage = materialsPagination.current + 1
          const res = await apiGetMaterialList(planId, nextPage, materialsPagination.pageSize, materialsFilter)
          const resData = res?.data as { list?: any[], total?: number } | undefined
          const list = (resData?.list || []) as PromotionMaterial[]
          const total = resData?.total || 0

          set({
            materials: [...materials, ...list],
            materialsPagination: {
              ...materialsPagination,
              current: nextPage,
              total,
              hasMore: list.length === materialsPagination.pageSize,
            },
          })
        }
        catch {
          // 错误由调用方处理
        }
        finally {
          set({ materialsLoading: false })
        }
      },

      /**
       * 删除素材
       */
      deleteMaterial: async (materialId: string): Promise<boolean> => {
        set({ isSubmitting: true })
        try {
          const res = await apiDeleteMaterial(materialId)
          const { currentPlan, materialsPagination } = get()
          if (res?.code !== 0) {
            // 删除没成功也要重新拉列表：界面上的这条可能已经是"幽灵"——
            // 列表来自上一次会话的缓存 id，服务端早已没有它，于是每次点都失败、
            // 用户只能切走再切回来（重新拉取）才删得掉。刷新一次让界面回到事实，
            // 用户看到的是"这条本来就不在了"，而不是反复报错的同一个红点。
            if (currentPlan)
              await methods.fetchMaterials(currentPlan.id, materialsPagination.current)
            return false
          }
          if (currentPlan) {
            await methods.fetchMaterials(currentPlan.id, materialsPagination.current)

            removeDraftItemsFromMediaTabs([materialId])
          }
          return true
        }
        catch {
          return false
        }
        finally {
          set({ isSubmitting: false })
        }
      },

      // ==================== 发布记录 ====================

      /**
       * 获取发布记录
       */
      fetchPublishRecords: async (_planId: string, page: number = 1, source?: PublishRecordSource) => {
        const { publishRecordsPagination } = get()
        set({
          PublishRecordSource: source ?? get().PublishRecordSource,
          publishRecords: [],
          publishRecordsLoading: false,
          publishRecordsPagination: {
            ...publishRecordsPagination,
            current: page,
            total: 0,
            hasMore: false,
          },
        })
      },

      loadMorePublishRecords: async (_planId: string) => {
        set({ publishRecordsLoading: false })
      },

      fetchStatistics: async (_planId: string, source?: PublishRecordSource) => {
        set({
          PublishRecordSource: source ?? get().PublishRecordSource,
          statistics: {
            materialCount: 0,
            publishCount: 0,
            viewCount: 0,
            likeCount: 0,
            commentCount: 0,
            shareCount: 0,
            favoriteCount: 0,
          },
          statisticsLoading: false,
        })
      },

      // ==================== 弹窗控制 ====================

      openCreateMaterialModal: () => {
        set({ createMaterialModalOpen: true, editingMaterial: null })
      },

      openEditMaterialModal: (material: PromotionMaterial) => {
        set({ createMaterialModalOpen: true, editingMaterial: material })
      },

      closeMaterialModal: () => {
        set({ createMaterialModalOpen: false, editingMaterial: null })
      },

      // ==================== 草稿详情弹窗 ====================

      openDraftDetailDialog: (material: PromotionMaterial) => {
        set({ draftDetailDialogOpen: true, selectedDraft: material })
      },

      closeDraftDetailDialog: () => {
        set({ draftDetailDialogOpen: false, selectedDraft: null })
      },

      // ==================== 发布弹框 ====================

      openPublishDialog: (draft: PromotionMaterial | null, options?: { autoPublish?: boolean }) => {
        // 清空上次发布的缓存数据，避免 PublishDialog 触发「是否恢复」确认弹框
        usePublishDialogStorageStore.getState().clearPubData()
        set({ publishDialogOpen: true, publishingDraft: draft, publishAutoMode: options?.autoPublish === true })
      },

      closePublishDialog: () => {
        set({ publishDialogOpen: false, publishingDraft: null, publishAutoMode: false })
      },

      setPendingAutoSync: (accountId: string | null) => {
        set({ pendingAutoSyncAccountId: accountId })
      },

      consumePendingAutoSync: () => {
        set({ pendingAutoSyncAccountId: null })
      },

      // ==================== AI 批量生成 ====================

      openAiBatchModal: () => {
        set({ aiBatchModalOpen: true })
      },

      closeAiBatchModal: () => {
        set({ aiBatchModalOpen: false })
      },

      openGenerationDetailDialog: () => {
        set({ generationDetailDialogOpen: true })
      },

      closeGenerationDetailDialog: () => {
        set({ generationDetailDialogOpen: false })
      },

      syncGenerationTasks: (tasks: DraftGenerationTask[]) => {
        const groupId = get().currentPlan?.id || get().initializedPlanId
        const currentTaskIds = new Set(get().generationTasks.map(task => task.id))
        const scopedTasks = groupId
          ? tasks.filter(task => isDraftGenerationTaskForGroup(task, groupId) || currentTaskIds.has(task.id))
          : tasks
        const generationTasks = mergeDraftGenerationTasks(get().generationTasks, scopedTasks)
        set({
          generationTasks,
          generatingCount: countGeneratingTasks(generationTasks),
        })
      },

      replaceGenerationTasks: (tasks: DraftGenerationTask[]) => {
        const groupId = get().currentPlan?.id || get().initializedPlanId
        const generationTasks = sortDraftGenerationTasks(
          // 生成记录页展示全部任务历史：终态任务不受组限制，进行中任务按当前组匹配
          tasks.filter(task => task.status !== 'generating' || isDraftGenerationTaskForGroup(task, groupId ?? '')),
        )
        set({
          generationTasks,
          generatingCount: countGeneratingTasks(generationTasks),
        })
      },

      /**
       * 删除一条或多条生成任务记录
       */
      deleteGenerationTasks: async (taskIds: string[]): Promise<boolean> => {
        const ids = Array.from(new Set(taskIds.filter(Boolean)))
        if (ids.length === 0)
          return false
        try {
          const res = await apiDeleteDraftGenerations(ids)
          if (res?.code !== 0)
            return false
          const nextGenerationTasks = get().generationTasks.filter(task => !ids.includes(task.id))
          set({
            generationTasks: nextGenerationTasks,
            generatingCount: countGeneratingTasks(nextGenerationTasks),
          })
          return true
        }
        catch {
          return false
        }
      },

      /**
       * 清空全部生成任务记录
       */
      clearGenerationTasks: async (): Promise<boolean> => {
        try {
          const res = await apiClearDraftGenerations()
          if (res?.code !== 0)
            return false
          set({ generationTasks: [], generatingCount: 0 })
          return true
        }
        catch {
          return false
        }
      },

      /**
       * 初始化当前草稿箱生成中任务，用于刷新页面后恢复进度展示
       */
      fetchGenerationTasks: async (planId: string) => {
        try {
          const res = await apiGetDraftGenerationList(1, 100)
          // 展示当前用户全部生成任务历史（含已成功/失败），组匹配失败时也纳入，
          // 保证「生成记录」页永远有真实记录可看
          const list = (res?.data?.list || []).filter(
            task => (task.request?.groupId ?? '') === (planId ?? '') || task.status !== 'generating',
          )
          methods.replaceGenerationTasks(list)
        }
        catch (error) {
          // 静默失败
        }
      },

      /**
       * 根据已知 taskIds 刷新生成任务详情
       */
      queryGenerationTasks: async (taskIds: string[]) => {
        if (taskIds.length === 0)
          return []

        try {
          const results = await Promise.all(
            chunkTaskIds(taskIds).map(async (ids) => {
              const res = await apiQueryDraftGenerationTasks(ids)
              return res?.data || []
            }),
          )
          const tasks = results.flat()
          methods.syncGenerationTasks(tasks)
          return tasks
        }
        catch {
          return []
        }
      },

      /**
       * 创建 AI 批量生成任务
       */
      createBatchGeneration: async (
        quantity: number,
        modelType: string,
        duration?: number,
        resolution?: string,
        aspectRatio?: string,
        prompt?: string,
        imageUrls?: string[],
        videoUrls?: string[],
        audioUrls?: string[],
        overrideGroupId?: string,
        platforms?: PlatType[],
        draftType?: VideoDraftType,
        captionPrompt?: string,
        style?: string,
      ) => {
        const groupId = overrideGroupId || get().currentPlan?.id
        if (!groupId)
          return false

        set({ isGeneratingBatch: true })
        try {
          const res = await apiCreateDraftGeneration({
            quantity,
            groupId,
            model: modelType,
            duration,
            resolution,
            aspectRatio,
            prompt,
            captionPrompt: captionPrompt || undefined,
            style: style || undefined,
            imageUrls,
            videoUrls,
            audioUrls,
            platforms: platforms?.length ? platforms : undefined,
            draftType,
          })
          if (res?.code === 0) {
            const taskIds = res.data?.taskIds || []
            methods.syncGenerationTasks(taskIds.map(id => buildDraftGenerationTaskPlaceholder(id, {
              groupId,
              model: modelType,
              duration,
              resolution,
              aspectRatio,
              prompt,
              captionPrompt: captionPrompt || undefined,
              style: style || undefined,
              imageUrls,
              videoUrls,
              audioUrls,
              platforms,
              draftType,
            })))
            return true
          }
          else {
            if (res?.message)
              toast.error(res.message)
            return false
          }
        }
        catch {
          return false
        }
        finally {
          set({ isGeneratingBatch: false })
        }
      },

      /**
       * 按多个视频模型并发创建 AI 批量生成任务
       */
      createBatchGenerationWithModels: async (
        quantity: number,
        modelInputs: VideoModelGenerationInput[],
        duration?: number,
        aspectRatio?: string,
        prompt?: string,
        imageUrls?: string[],
        videoUrls?: string[],
        audioUrls?: string[],
        overrideGroupId?: string,
        platforms?: PlatType[],
        draftType?: VideoDraftType,
        captionPrompt?: string,
        style?: string,
      ): Promise<BatchGenerationCreateResult> => {
        const groupId = overrideGroupId || get().currentPlan?.id
        const uniqueModelInputs = Array.from(
          new Map(modelInputs.filter(item => item.modelType).map(item => [item.modelType, item])).values(),
        )
        if (!groupId || uniqueModelInputs.length === 0) {
          return { success: false, successCount: 0, failedCount: uniqueModelInputs.length, taskCount: 0 }
        }

        set({ isGeneratingBatch: true })
        try {
          const results = await Promise.allSettled(
            uniqueModelInputs.map(async ({ modelType, resolution, duration: inputDuration, aspectRatio: inputAspectRatio }) => {
              const resolvedDuration = inputDuration ?? duration
              const resolvedAspectRatio = inputAspectRatio ?? aspectRatio
              const res = await apiCreateDraftGeneration({
                quantity,
                groupId,
                model: modelType,
                duration: resolvedDuration,
                resolution,
                aspectRatio: resolvedAspectRatio,
                prompt,
                captionPrompt: captionPrompt || undefined,
                style: style || undefined,
                imageUrls,
                videoUrls,
                audioUrls,
                platforms: platforms?.length ? platforms : undefined,
                draftType,
              })

              if (res?.code !== 0)
                throw new Error(res?.message || 'Failed to create generation task')

              return {
                modelType,
                resolution,
                duration: resolvedDuration,
                aspectRatio: resolvedAspectRatio,
                taskIds: res.data?.taskIds || [],
              }
            }),
          )

          const fulfilled = results.filter(result => result.status === 'fulfilled')
          const placeholders = results.flatMap((result) => {
            if (result.status !== 'fulfilled')
              return []
            return result.value.taskIds.map((id: string) => buildDraftGenerationTaskPlaceholder(id, {
              groupId,
              model: result.value.modelType,
              duration: result.value.duration,
              resolution: result.value.resolution,
              aspectRatio: result.value.aspectRatio,
              prompt,
              captionPrompt: captionPrompt || undefined,
              style: style || undefined,
              imageUrls,
              videoUrls,
              audioUrls,
              platforms,
              draftType,
            }))
          })

          if (placeholders.length > 0)
            methods.syncGenerationTasks(placeholders)

          const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          return {
            success: fulfilled.length > 0,
            successCount: fulfilled.length,
            failedCount: failed.length,
            taskCount: placeholders.length,
            errorMessage: failed.map(getSettledErrorMessage).find(Boolean),
          }
        }
        finally {
          set({ isGeneratingBatch: false })
        }
      },

      /**
       * 创建 AI 图文批量生成任务
       */
      createImageTextBatchGeneration: async (
        quantity: number,
        imageModel: ImageModelType,
        prompt: string,
        imageCount?: number,
        aspectRatio?: string,
        imageUrls?: string[],
        overrideGroupId?: string,
        imageSize?: string,
        platforms?: PlatType[],
        draftType?: ImageTextDraftType,
        captionPrompt?: string,
        style?: string,
      ) => {
        const groupId = overrideGroupId || get().currentPlan?.id
        if (!groupId)
          return false

        set({ isGeneratingBatch: true })
        try {
          const res = await apiCreateImageTextDraft({
            quantity,
            groupId,
            prompt,
            captionPrompt: captionPrompt || undefined,
            style: style || undefined,
            imageModel,
            imageCount,
            imageUrls,
            aspectRatio,
            imageSize,
            platforms: platforms?.length ? platforms : undefined,
            draftType,
          })
          if (res?.code === 0) {
            const taskIds = res.data?.taskIds || []
            methods.syncGenerationTasks(taskIds.map(id => buildDraftGenerationTaskPlaceholder(id, {
              groupId,
              imageModel,
              prompt,
              captionPrompt: captionPrompt || undefined,
              style: style || undefined,
              imageCount,
              imageUrls,
              aspectRatio,
              imageSize,
              platforms,
              draftType,
            })))
            return true
          }
          else {
            if (res?.message)
              toast.error(res.message)
            return false
          }
        }
        catch {
          return false
        }
        finally {
          set({ isGeneratingBatch: false })
        }
      },

      /**
       * 按多个图片模型并发创建 AI 图文批量生成任务
       */
      createImageTextBatchGenerationWithModels: async (
        quantity: number,
        imageModels: ImageModelType[],
        prompt: string,
        imageCount?: number,
        aspectRatio?: string,
        imageUrls?: string[],
        overrideGroupId?: string,
        imageSize?: string,
        platforms?: PlatType[],
        draftType?: ImageTextDraftType,
        captionPrompt?: string,
        style?: string,
      ): Promise<BatchGenerationCreateResult> => {
        const groupId = overrideGroupId || get().currentPlan?.id
        const uniqueImageModels = [...new Set(imageModels.filter(Boolean))]
        if (!groupId || uniqueImageModels.length === 0) {
          return { success: false, successCount: 0, failedCount: uniqueImageModels.length, taskCount: 0 }
        }

        set({ isGeneratingBatch: true })
        try {
          const results = await Promise.allSettled(
            uniqueImageModels.map(async (imageModel) => {
              const res = await apiCreateImageTextDraft({
                quantity,
                groupId,
                prompt,
                captionPrompt: captionPrompt || undefined,
                style: style || undefined,
                imageModel,
                imageCount,
                imageUrls,
                aspectRatio,
                imageSize,
                platforms: platforms?.length ? platforms : undefined,
                draftType,
              })

              if (res?.code !== 0)
                throw new Error(res?.message || 'Failed to create generation task')

              return {
                imageModel,
                taskIds: res.data?.taskIds || [],
              }
            }),
          )

          const fulfilled = results.filter((result): result is PromiseFulfilledResult<{ imageModel: ImageModelType, taskIds: string[] }> => result.status === 'fulfilled')
          const placeholders = fulfilled.flatMap(({ value }) => value.taskIds.map(id => buildDraftGenerationTaskPlaceholder(id, {
            groupId,
            imageModel: value.imageModel,
            prompt,
            captionPrompt: captionPrompt || undefined,
            style: style || undefined,
            imageCount,
            imageUrls,
            aspectRatio,
            imageSize,
            platforms,
            draftType,
          })))

          if (placeholders.length > 0)
            methods.syncGenerationTasks(placeholders)

          const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          return {
            success: fulfilled.length > 0,
            successCount: fulfilled.length,
            failedCount: failed.length,
            taskCount: placeholders.length,
            errorMessage: failed.map(getSettledErrorMessage).find(Boolean),
          }
        }
        finally {
          set({ isGeneratingBatch: false })
        }
      },

      /**
       * 获取生成中任务数量（初始化时调用）
       */
      fetchGeneratingStats: async () => {
        try {
          const res = await apiGetDraftGenerationStats()
          if (res?.data) {
            set({ generatingCount: res.data.generatingCount || 0 })
          }
        }
        catch {
          // 静默失败
        }
      },

      /**
       * 轮询回调：更新生成中任务数量
       */
      updateGeneratingCount: (count: number) => {
        set({ generatingCount: count })
      },

      /**
       * 无感刷新素材列表（不触发 loading/骨架屏）
       * 静默请求第1页数据，找出新增的草稿 prepend 到头部
       */
      silentRefreshMaterials: async (planId: string) => {
        try {
          const { materialsPagination, materials, materialsFilter } = get()
          const res = await apiGetMaterialList(planId, 1, materialsPagination.pageSize, materialsFilter)
          const resData = res?.data as { list?: any[], total?: number } | undefined
          const freshList = (resData?.list || []) as PromotionMaterial[]
          const total = resData?.total || 0

          // 构建当前 materials 的 id Set
          const existingIds = new Set(materials.map(m => m.id))
          // 找出新增草稿
          const newItems = freshList.filter(item => !existingIds.has(item.id))

          if (newItems.length > 0) {
            set({
              materials: [...newItems, ...materials],
              materialsPagination: {
                ...materialsPagination,
                total,
              },
            })
          }
        }
        catch {
          // 静默失败
        }
      },

      /**
       * 外部写入草稿数据（不发请求）
       * 用于 mediaTabStore.fetchAllList 初始加载后同步草稿到 planDetailStore
       */
      setMaterialsFromExternal: (list: PromotionMaterial[], total: number, pageSize: number) => {
        set({
          materials: list,
          materialsInitialized: true,
          materialsLoading: false,
          materialsPagination: {
            current: 1,
            pageSize,
            total,
            hasMore: list.length < total,
          },
        })
      },

      /**
       * 外部同步新增草稿（不发请求，prepend 新增项）
       * 用于 mediaTabStore.silentRefreshAll 后同步新增草稿
       */
      syncMaterialsFromFresh: (freshList: PromotionMaterial[], total: number) => {
        const { materials, materialsPagination } = get()
        const existingIds = new Set(materials.map(m => m.id))
        const newItems = freshList.filter(item => !existingIds.has(item.id))

        if (newItems.length > 0) {
          set({
            materials: [...newItems, ...materials],
            materialsPagination: {
              ...materialsPagination,
              total,
            },
          })
        }
      },

      /**
       * 外部追加草稿（不发请求）
       * 用于 mediaTabStore.loadMoreAll 加载更多草稿后同步
       */
      appendMaterials: (list: PromotionMaterial[], total: number) => {
        const { materials, materialsPagination } = get()
        // 去重后追加
        const existingIds = new Set(materials.map(m => m.id))
        const newItems = list.filter(item => !existingIds.has(item.id))
        if (newItems.length > 0) {
          set({
            materials: [...materials, ...newItems],
            materialsPagination: {
              ...materialsPagination,
              total,
              hasMore: (materials.length + newItems.length) < total,
            },
          })
        }
      },

      // ==================== 搜索/筛选 & 批量操作 ====================

      setMaterialsFilter: (filter: MaterialListFilters) => {
        const { currentPlan } = get()
        set({
          materialsFilter: filter,
          materials: [],
          materialsPagination: {
            current: 1,
            pageSize: 12,
            total: 0,
            hasMore: true,
          },
        })
        if (currentPlan) {
          methods.fetchMaterials(currentPlan.id, 1)
        }
      },

      resetMaterialsFilter: () => {
        methods.setMaterialsFilter({})
      },

      enterBatchMode: () => {
        set({ batchMode: true, selectedMaterialIds: [] })
      },

      exitBatchMode: () => {
        set({ batchMode: false, selectedMaterialIds: [] })
      },

      toggleMaterialSelection: (id: string) => {
        const { selectedMaterialIds } = get()
        const index = selectedMaterialIds.indexOf(id)
        if (index === -1) {
          set({ selectedMaterialIds: [...selectedMaterialIds, id] })
        }
        else {
          set({ selectedMaterialIds: selectedMaterialIds.filter(i => i !== id) })
        }
      },

      selectAllLoadedMaterials: () => {
        const { materials } = get()
        set({ selectedMaterialIds: materials.map(m => m.id) })
      },

      deselectAllMaterials: () => {
        set({ selectedMaterialIds: [] })
      },

      batchDeleteMaterials: async () => {
        const { selectedMaterialIds, currentPlan } = get()
        if (selectedMaterialIds.length === 0 || !currentPlan)
          return false
        set({ batchDeleting: true })
        try {
          const res = await apiBatchDeleteMaterials(selectedMaterialIds)
          if (res?.code !== 0) {
            // 同 deleteMaterial：失败时也刷新列表并退出批量模式，
            // 否则勾选状态与幽灵条目会一起把用户困在"怎么点都不行"里。
            set({ batchMode: false, selectedMaterialIds: [] })
            await methods.fetchMaterials(currentPlan.id, 1)
            return false
          }
          set({ batchMode: false, selectedMaterialIds: [] })
          await methods.fetchMaterials(currentPlan.id, 1)
          // 同步更新全部 Tab
          removeDraftItemsFromMediaTabs(selectedMaterialIds)
          return true
        }
        catch {
          return false
        }
        finally {
          set({ batchDeleting: false })
        }
      },

      openConditionalDeleteDialog: () => {
        set({ conditionalDeleteDialogOpen: true })
      },

      closeConditionalDeleteDialog: () => {
        set({ conditionalDeleteDialogOpen: false })
      },

      filterDeleteMaterials: async (conditions: Omit<MaterialFilterDeleteParams, 'groupId'>) => {
        const { currentPlan } = get()
        if (!currentPlan)
          return false
        try {
          const res = await apiFilterDeleteMaterials({ ...conditions, groupId: currentPlan.id })
          if (res?.code !== 0)
            return false
          set({ conditionalDeleteDialogOpen: false })
          await methods.fetchMaterials(currentPlan.id, 1)
          // 条件删除无法确定删除了哪些 ID，重新拉取全部 Tab
          refreshDraftItemsInMediaTabs(currentPlan.id, currentPlan.id)
          return true
        }
        catch {
          return false
        }
      },

      // ==================== 重置 ====================

      reset: () => {
        set(getInitialState())
      },

      /**
       * 初始化详情页数据
       * @param planId 计划 ID
       * @param force 是否强制重新加载（Tab 切换时使用）
       */
      initDetailPage: async (planId: string, force: boolean = false, options?: { source?: PublishRecordSource }) => {
        // 如果已经初始化过相同的 planId 且非强制刷新，跳过
        const { initializedPlanId } = get()
        if (!force && initializedPlanId === planId) {
          return
        }

        // 重置状态
        set(getInitialState())
        // 标记正在初始化的 planId
        set({ initializedPlanId: planId, PublishRecordSource: options?.source })

        // 并行加载数据
        await Promise.all([
          methods.fetchPlanDetail(planId),
          methods.fetchMaterials(planId, 1),
          methods.fetchStatistics(planId, options?.source),
          methods.fetchPublishRecords(planId, 1, options?.source),
          methods.fetchGenerationTasks(planId),
        ])
      },

      /**
       * 仅加载「内容管理」所需数据
       * 加载: planDetail + materials + generatingStats
       */
      initContentData: async (planId: string, force: boolean = false, options?: { skipMaterials?: boolean }) => {
        const { initializedPlanId } = get()
        if (!force && initializedPlanId === planId) {
          return
        }

        // 重置状态
        set(getInitialState())
        set({ initializedPlanId: planId })

        if (options?.skipMaterials) {
          // 跳过素材加载时，将 loading 置为 false 避免骨架屏卡住
          set({ materialsLoading: false })
          await Promise.all([
            methods.fetchPlanDetail(planId),
            methods.fetchGenerationTasks(planId),
          ])
        }
        else {
          await Promise.all([
            methods.fetchPlanDetail(planId),
            methods.fetchMaterials(planId, 1),
            methods.fetchGenerationTasks(planId),
          ])
        }
      },

      /**
       * 仅加载「数据分析」所需数据
       * 加载: statistics + publishRecords
       * planDetail 复用已加载的缓存
       */
      initAnalyticsData: async (planId: string, force: boolean = false, options?: { source?: PublishRecordSource }) => {
        const { analyticsInitialized } = get()
        if (!force && analyticsInitialized) {
          return
        }

        set({ analyticsInitialized: true, PublishRecordSource: options?.source })

        await Promise.all([
          methods.fetchStatistics(planId, options?.source),
          methods.fetchPublishRecords(planId, 1, options?.source),
        ])
      },
    }

    return methods
  }),
)

registerPlanDetailMaterialSyncAdapter({
  setMaterialsFromExternal: (list, total, pageSize) => {
    usePlanDetailStore.getState().setMaterialsFromExternal(list, total, pageSize)
  },
  syncMaterialsFromFresh: (freshList, total) => {
    usePlanDetailStore.getState().syncMaterialsFromFresh(freshList, total)
  },
  appendMaterials: (list, total) => {
    usePlanDetailStore.getState().appendMaterials(list, total)
  },
  isCurrentPlan: (planId) => {
    return usePlanDetailStore.getState().currentPlan?.id === planId
  },
  silentRefreshMaterials: (planId) => {
    return usePlanDetailStore.getState().silentRefreshMaterials(planId)
  },
  refreshCurrentMaterials: async () => {
    const store = usePlanDetailStore.getState()
    if (store.currentPlan) {
      await store.fetchMaterials(store.currentPlan.id, 1)
    }
  },
})
