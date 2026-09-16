/**
 * CustomLlmTab - 设置 → 自定义大模型（AI 模型服务）
 *
 * 版式沿用 0.2.31 参考基线（品牌色卡片 + 中文说明），并把「只能配一个模型」
 * 扩成多服务 / 多模型：
 *   ① 我的模型服务：已保存服务的列表，可添加、切换当前使用、删除；
 *   ② 使用你自己的 AI 钥匙：编辑当前选中的服务（接口地址 / API Key / 模型名称与模型列表）；
 *   ③ 图片模型 / 视频模型（选填）：全局媒体通道；
 *   ④ 钥匙安全说明与常见问题。
 *
 * 数据仍走本机服务 `ai/user-llm`：整列表提交 providers[] + activeProviderId，
 * 服务端据此重写 DSH settings.yaml / .credentials.yaml，内核 llm-pi-ai 路由随之切换
 * （保存后立刻用 /models 探活一次）；未配置时以内置模板回复。
 */
'use client'

import type { ReactNode } from 'react'
import { CheckCircle2, Cpu, Info, Loader2, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Input } from '@web/components/ui/input'
import { Label } from '@web/components/ui/label'
import http from '@web/utils/request'
import { toast } from '@web/utils/ui/toast'
import { loadUserLlm, saveUserLlm } from '@web/utils/userLlm'
import { ModelPickerDialog } from './customLlm/ModelPickerDialog'
import type { MediaPick, ModelKind } from './customLlm/types'
import { ProviderEditor } from './customLlm/ProviderEditor'
import { ProviderList } from './customLlm/ProviderList'
import {
  DEFAULT_PROTOCOL,
  displayHost,
  draftModels,
  draftProblem,
  newDraft,
  providerLabel,
  toDraft,
  withModelKind,
  type ProviderDraft,
  type ServerLlmConfig,
} from './customLlm/types'

/** 服务端提交用的提供方字段（见 server/src/api.ts 的 PUT ai/user-llm）。 */
interface ProviderPayload {
  id: string
  displayName: string
  builtin: boolean
  baseUrl: string
  protocol: string
  apiKey: string
  models: string[]
  modelLabels: Record<string, string>
  modelOptions: Record<string, { name?: string; contextWindow?: number; maxTokens?: number }>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 字段行：标签 + 控件 + 可选提示，保证整页标签与间距一致。 */
function Field({ label, hint, htmlFor, children }: {
  label: string
  hint?: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
      {hint !== undefined && <p className="text-xs leading-5 text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * 把服务端返回的配置整理成编辑态服务列表。
 *
 * 三级兜底：providers[] → 顶层单配置镜像（老数据）→ 浏览器副本，
 * 都没有才给一张空表单；任何一级命中都不必让用户重填密钥。
 */
function initialProviders(data: ServerLlmConfig | undefined): ProviderDraft[] {
  const list = (Array.isArray(data?.providers) ? data.providers : [])
    .filter(item => (item.id ?? '').trim() !== '')
    .map((item, index) => toDraft(item, 'custom-' + String(index + 1)))
  if (list.length > 0)
    return list

  const local = loadUserLlm()
  const serverBase = (data?.baseUrl ?? '').trim()
  const serverModel = (data?.model ?? '').trim()
  if (serverBase !== '' && serverModel !== '') {
    // 顶层镜像就是内核当前在用的那一个路由（旧版 id 固定 agnes），还原成一个服务。
    const serverModels = (Array.isArray(data?.models) ? data.models : []).filter(id => id.trim() !== '')
    return [{
      ...newDraft([]),
      // 顶层镜像已经是服务端在用的配置：按已保存呈现，用户在它基础上改。
      isNew: false,
      id: 'agnes',
      displayName: (data?.displayName ?? '').trim(),
      baseUrl: serverBase,
      protocol: (data?.protocol ?? '').trim() !== '' ? (data?.protocol ?? '') : DEFAULT_PROTOCOL,
      apiKey: local !== null && local.baseUrl === serverBase ? local.apiKey : '',
      hasApiKey: data?.hasApiKey === true,
      models: serverModels.length > 0 ? serverModels : [serverModel],
      model: serverModel,
    }]
  }
  // 服务端没配置但浏览器还留着明文副本：用它把表单填回来，避免用户重填。
  if (local !== null) {
    return [{
      ...newDraft([]),
      displayName: local.displayName ?? '',
      baseUrl: local.baseUrl,
      protocol: local.protocol ?? DEFAULT_PROTOCOL,
      apiKey: local.apiKey,
      hasApiKey: true,
      models: local.models ?? [local.model],
      model: local.model,
    }]
  }
  // 什么都没配过：返回空列表，界面上就是"还没有服务"。
  // 这里以前会塞一张预填 Agnes 地址的空卡——用户没配过却看到一条"Agnes AI（未保存）"，
  // 既像残留数据又像默认模型；想引导用户去 Agnes，用服务区的官网按钮，不要替他建配置。
  return []
}

/**
 * 把服务端已保存的图片 / 视频通道落回它所属的服务目录。
 *
 * 老配置只存了 baseUrl + model（没有服务 id）：优先按模型命中，
 * 其次按接口地址匹配，地址为空则归给当前生效的服务；
 * 命中后把模型补进该服务目录并标上用途，用户就能在厂商列表里看到并改它。
 *
 * @param list - 已还原的服务草稿列表（原地修改 models / modelOptions）。
 * @param media - 服务端保存的图片或视频通道。
 * @param kind - 通道用途，决定标成 image 还是 video。
 * @param activeDraftId - 地址为空时的兜底归属服务。
 * @returns 该通道的归属；没有配置时返回 null。
 */
function attachMediaModel(
  list: ProviderDraft[],
  media: { model?: string, baseUrl?: string } | undefined,
  kind: 'image' | 'video',
  activeDraftId: string,
): MediaPick | null {
  const model = (media?.model ?? '').trim()
  if (model === '' || list.length === 0)
    return null
  const mediaBaseUrl = (media?.baseUrl ?? '').trim()
  const owner = list.find(item => item.models.includes(model))
    ?? list.find(item => mediaBaseUrl !== '' && item.baseUrl.trim() === mediaBaseUrl)
    ?? list.find(item => item.id === activeDraftId)
    ?? list[0]
  if (owner === undefined)
    return null
  if (!owner.models.includes(model))
    owner.models = [...owner.models, model]
  owner.modelOptions = { ...owner.modelOptions, [model]: { ...owner.modelOptions[model], kind } }
  return { providerId: owner.id, model }
}

export function CustomLlmTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [providers, setProviders] = useState<ProviderDraft[]>([])
  /** 服务端基线：用于「取消」还原单个服务。 */
  const [saved, setSaved] = useState<ProviderDraft[]>([])
  const [activeId, setActiveId] = useState('')
  const [selectedId, setSelectedId] = useState('')
  /** 整页脏标记（含当前生效服务）：与最近一次保存 / 载入结果比对。 */
  const [baseline, setBaseline] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [candidates, setCandidates] = useState<string[]>([])
  /** 「选择要添加的模型」弹窗：由「获取可用模型」成功后打开。 */
  const [pickerOpen, setPickerOpen] = useState(false)

  /** 当前图片 / 视频模型：指向某个服务目录里的某个模型。 */
  const [imagePick, setImagePick] = useState<MediaPick | null>(null)
  const [videoPick, setVideoPick] = useState<MediaPick | null>(null)

  /** 同时刷新编辑列表与服务端基线：列表与服务端从此一致，脏标记归零。 */
  const applyLocal = useCallback((list: ProviderDraft[], nextActiveId: string) => {
    setProviders(list)
    setSaved(list)
    setActiveId(nextActiveId)
    // 收纳列表默认全部收起；原来展开的那张卡被删掉时才归零，不自动改展开别家。
    setSelectedId(current => (list.some(item => item.id === current) ? current : ''))
    setBaseline(JSON.stringify({ p: list, a: nextActiveId }))
  }, [])

  useEffect(() => {
    let cancelled = false
    void http.get<ServerLlmConfig>('ai/user-llm', undefined, true)
      .then((res) => {
        if (cancelled)
          return
        const data = res?.data
        const list = initialProviders(data)
        const active = data?.activeProviderId !== undefined && data.activeProviderId !== ''
          ? data.activeProviderId
          : (list[0]?.id ?? '')
        const activeDraftId = list.some(item => item.id === active) ? active : (list[0]?.id ?? '')
        // 已保存的图片 / 视频通道落回它所属的服务目录（老配置没有服务 id，按模型或地址匹配）。
        setImagePick(attachMediaModel(list, data?.image, 'image', activeDraftId))
        setVideoPick(attachMediaModel(list, data?.video, 'video', activeDraftId))
        applyLocal(list, activeDraftId)
        // 唯一还需要用户动手的服务（缺密钥）默认展开：收纳不能把「还差一步」藏起来。
        setSelectedId(list.find(item => item.apiKey.trim() === '' && !item.hasApiKey)?.id ?? '')
      })
      .catch(() => {
        // 读取失败按「未配置」呈现：表单仍可填写并保存，不阻塞 BYOK 入口。
        if (!cancelled)
          applyLocal([], '')
      })
      .finally(() => {
        if (!cancelled)
          setLoading(false)
      })

    return () => { cancelled = true }
  }, [applyLocal])

  const selected = useMemo(
    () => providers.find(item => item.id === selectedId),
    [providers, selectedId],
  )
  const active = useMemo(() => providers.find(item => item.id === activeId), [providers, activeId])
  const configured = useMemo(() => providers.some(item => item.hasApiKey || item.apiKey.trim() !== ''), [providers])
  const dirty = useMemo(() => JSON.stringify({ p: providers, a: activeId }) !== baseline, [providers, activeId, baseline])
  /** 当前编辑的这个服务有没有未保存改动：决定编辑区是否出现「取消」。 */
  const selectedDirty = useMemo(() => {
    if (selected === undefined)
      return false
    if (selected.isNew)
      return true
    const original = saved.find(item => item.id === selected.id)
    return original === undefined || JSON.stringify(original) !== JSON.stringify(selected)
  }, [saved, selected])

  // 图片 / 视频模型和对话模型同源：只报"哪个服务 + 哪个模型"，接口地址与密钥由服务端
  // 按所属服务补齐（前端拿不到别的服务的密钥）。空串是显式清空，不是"没提交"。
  const mediaPayload = useMemo(() => ({
    image: imagePick !== null ? { providerId: imagePick.providerId, model: imagePick.model } : { model: '' },
    video: videoPick !== null ? { providerId: videoPick.providerId, model: videoPick.model } : { model: '' },
  }), [imagePick, videoPick])

  /** 写入浏览器副本（仅本机回填用）：密钥沿用已保存的那份，不上传任何第三方。 */
  const mirrorLocal = useCallback((nextActive: ProviderDraft | undefined) => {
    if (nextActive === undefined)
      return
    const local = loadUserLlm()
    const key = nextActive.apiKey.trim() !== ''
      ? nextActive.apiKey.trim()
      : (local !== null && local.baseUrl === nextActive.baseUrl.trim() ? local.apiKey : '')
    if (key === '')
      return
    saveUserLlm({
      baseUrl: nextActive.baseUrl.trim(),
      apiKey: key,
      model: nextActive.model.trim(),
      displayName: providerLabel(nextActive.displayName, nextActive.baseUrl),
      protocol: nextActive.protocol,
      models: draftModels(nextActive),
    })
  }, [])

  /**
   * 提交整张服务列表到本机服务。
   * @returns 是否写入成功；失败时错误已呈现在面板上。
   */
  const persist = useCallback(async (list: ProviderDraft[], nextActiveId: string): Promise<boolean> => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const payload = list.map((draft): ProviderPayload => ({
        id: draft.id,
        displayName: providerLabel(draft.displayName, draft.baseUrl),
        builtin: false,
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol.trim() !== '' ? draft.protocol.trim() : DEFAULT_PROTOCOL,
        // 留空表示沿用服务端已保存的密钥（服务端按 id 保留旧值）。
        apiKey: draft.apiKey.trim(),
        models: draftModels(draft),
        modelLabels: draft.modelLabels,
        modelOptions: draft.modelOptions,
      }))
      const res = await http.put('ai/user-llm', {
        providers: payload,
        activeProviderId: nextActiveId,
        ...mediaPayload,
        // 清空整份服务是显式动作（删掉最后一个服务）：服务端要求明确表达，防静默清空。
        ...(payload.length === 0 ? { allowEmptyProviders: true } : {}),
      }, true)
      if (res === null || res.code !== 0) {
        setError(res?.message ?? '保存失败，请重试')
        return false
      }
      // 密钥已交给服务端保管，内存里不再保留明文；模型目录补齐当前模型，标签与服务端一致。
      const normalized = list.map(draft => ({
        ...draft,
        apiKey: '',
        hasApiKey: draft.hasApiKey || draft.apiKey.trim() !== '',
        models: draftModels(draft),
        isNew: false,
      }))
      applyLocal(normalized, nextActiveId)
      mirrorLocal(normalized.find(item => item.id === nextActiveId))
      return true
    }
    catch (caught) {
      setError(errorText(caught))
      return false
    }
    finally {
      setSaving(false)
    }
  }, [applyLocal, mediaPayload, mirrorLocal])

  const patchProvider = useCallback((id: string, patch: Partial<ProviderDraft>) => {
    setProviders(list => list.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  /** 丢掉一个尚未保存的服务：只改内存，不动服务端基线。 */
  const dropProvider = useCallback((id: string) => {
    const rest = providers.filter(item => item.id !== id)
    const next = rest
    setProviders(next)
    setSelectedId(current => (next.some(item => item.id === current) ? current : (next[0]?.id ?? '')))
  }, [providers])

  const handleAdd = useCallback(() => {
    setError('')
    setNotice('')
    setCandidates([])
    const draft = newDraft(providers)
    setProviders([...providers, draft])
    setSelectedId(draft.id)
  }, [providers])

  const handleSave = useCallback(async () => {
    setError('')
    setNotice('')
    // 新增但完全没填的服务直接丢弃，不拦保存。
    const filled = providers.filter(item => !(item.isNew
      && item.baseUrl.trim() === ''
      && item.model.trim() === ''
      && item.apiKey.trim() === ''
      && item.displayName.trim() === ''))
    if (filled.length === 0) {
      setError('请先添加一个模型服务：填好接口地址、API Key 与模型名称')
      return
    }
    for (const item of filled) {
      const problem = draftProblem(item, providerLabel(item.displayName, item.baseUrl))
      if (problem !== '') {
        setSelectedId(item.id)
        setError(problem)
        return
      }
    }
    const nextActiveId = filled.some(item => item.id === activeId) ? activeId : (filled[0]?.id ?? '')
    const ok = await persist(filled, nextActiveId)
    if (!ok)
      return

    const target = filled.find(item => item.id === nextActiveId)
    setNotice('已保存：此后所有 AI 功能都用你自己的钥匙')
    if (target === undefined)
      return

    // 保存后立刻探活一次：能列出模型说明地址与密钥可用，还能核对模型名是否拼错。
    const key = target.apiKey.trim() !== '' ? target.apiKey.trim() : (loadUserLlm()?.apiKey ?? '')
    if (key === '')
      return
    try {
      const probe = await http.post<{ models?: string[] }>(
        'ai/models/fetch',
        { baseUrl: target.baseUrl.trim(), apiKey: key },
        true,
      )
      const ids = probe?.data?.models ?? []
      const model = target.model.trim()
      if (probe?.code === 0 && ids.length > 0 && !ids.includes(model))
        toast.warning('已保存，但「' + model + '」不在该提供方的模型列表里，请核对模型名')
      else if (probe?.code === 0)
        toast.success('已保存并验证连接成功')
      else
        toast.warning('配置已保存，但连接验证失败：' + (probe?.message ?? '未知错误'))
    }
    catch (caught) {
      toast.warning('配置已保存，但连接验证失败：' + errorText(caught))
    }
  }, [activeId, persist, providers])

  const handleSetActive = useCallback(async (id: string) => {
    const target = providers.find(item => item.id === id)
    if (target === undefined)
      return
    const label = providerLabel(target.displayName, target.baseUrl)
    const problem = draftProblem(target, label)
    if (problem !== '') {
      setSelectedId(id)
      setError(problem + '（补齐后保存才能切换）')
      return
    }
    // 切换当前服务不改变正在编辑的那张卡：用户只是换了个生效项，不是要编辑它。
    const previousActiveId = activeId
    setActiveId(id)
    const ok = await persist(providers, id)
    if (ok)
      toast.success('已切换到「' + label + '」')
    else
      setActiveId(previousActiveId)
  }, [activeId, persist, providers])

  const handleRemove = useCallback(async (id: string) => {
    setError('')
    setNotice('')
    const target = providers.find(item => item.id === id)
    const rest = providers.filter(item => item.id !== id)
    const nextActiveId = id === activeId ? (rest[0]?.id ?? '') : activeId
    if (target?.isNew === true) {
      dropProvider(id)
      return
    }
    const ok = await persist(rest, nextActiveId)
    if (!ok)
      return
    // 删空了就补一张空表单，界面不出现「无编辑对象」的空窗。
    if (rest.length === 0)
      applyLocal([], '')
    toast.success(rest.length === 0 ? '已清除全部模型服务：AI 恢复未配置状态（模板兜底）' : '已删除该服务')
  }, [activeId, applyLocal, dropProvider, persist, providers])

  const handleCancel = useCallback(() => {
    setError('')
    setNotice('')
    if (selected === undefined)
      return
    if (selected.isNew) {
      dropProvider(selected.id)
      return
    }
    const original = saved.find(item => item.id === selected.id)
    if (original === undefined) {
      dropProvider(selected.id)
      return
    }
    setProviders(list => list.map(item => (item.id === selected.id ? original : item)))
  }, [dropProvider, saved, selected])

  const handleFetchModels = useCallback(async () => {
    if (selected === undefined)
      return
    setError('')
    setNotice('')
    const url = selected.baseUrl.trim()
    const key = selected.apiKey.trim() !== '' ? selected.apiKey.trim() : (loadUserLlm()?.apiKey ?? '')
    if (!/^https?:\/\//.test(url)) {
      setError('接口地址需以 http(s):// 开头')
      return
    }
    if (key === '') {
      setError('请先填写你的 API Key，再获取可用模型')
      return
    }
    setFetching(true)
    try {
      const res = await http.post<{ models?: string[] }>('ai/models/fetch', { baseUrl: url, apiKey: key }, true)
      if (res === null || res.code !== 0) {
        setError(res?.message ?? '获取可用模型失败，请检查 API 地址与密钥')
        return
      }
      const ids = res.data?.models ?? []
      if (ids.length === 0) {
        setError('接口没有返回任何模型，请检查 API 地址与密钥')
        return
      }
      setCandidates(ids)
      setPickerOpen(true)
    }
    catch (caught) {
      setError(errorText(caught))
    }
    finally {
      setFetching(false)
    }
  }, [selected])

  /**
   * 「选择要添加的模型」确认：勾选决定本次清单要哪些模型。
   *
   * 手工填过、但提供方这次没返回的模型一律保留——弹窗只负责"这份清单里选哪些"，
   * 不替用户删掉他自己写的模型。当前对话模型被移出时顺位补第一个。
   *
   * @param picked - 用户在弹窗里勾选的模型 id。
   */
  const handleConfirmModels = useCallback((picked: string[]) => {
    if (selected === undefined)
      return
    const manual = selected.models.filter(model => !candidates.includes(model))
    const models = [...new Set([...picked, ...manual])]
    const current = models.includes(selected.model.trim()) ? selected.model.trim() : (models[0] ?? '')
    patchProvider(selected.id, { models, model: current })
    setNotice('模型目录已更新为 ' + String(models.length) + ' 个模型，点「保存」后生效')
  }, [candidates, patchProvider, selected])

  /**
   * 改名一个模型：同步迁移它的显示名称，当前模型跟着改。
   *
   * @param from - 原模型 id。
   * @param to - 新模型 id（空值由调用方后续补全，这里先原样落下）。
   */
  const handleRenameModel = useCallback((from: string, to: string) => {
    if (selected === undefined)
      return
    const models = selected.models.map(model => (model === from ? to : model))
    const labels = { ...selected.modelLabels }
    const previous = labels[from]
    delete labels[from]
    if (previous !== undefined && to.trim() !== '')
      labels[to] = previous
    patchProvider(selected.id, {
      models,
      modelLabels: labels,
      model: selected.model.trim() === from ? to : selected.model,
    })
  }, [patchProvider, selected])

  /**
   * 改模型用途；标成图片 / 视频时顺手把它设为该通道的当前模型。
   *
   * 用户改用途的意图通常就是"以后用这个"，所以不要求他再点一次圆点；
   * 改回「对话」时如果它正是当前图片/视频模型，就把那个通道清掉，避免指向一个对话模型。
   *
   * @param model - 模型 id。
   * @param kind - 新用途。
   */
  const handleChangeModelKind = useCallback((model: string, kind: ModelKind) => {
    if (selected === undefined)
      return
    patchProvider(selected.id, { modelOptions: withModelKind(selected, model, kind) })
    const isCurrentImage = imagePick?.providerId === selected.id && imagePick.model === model
    const isCurrentVideo = videoPick?.providerId === selected.id && videoPick.model === model
    if (kind === 'image') {
      setImagePick({ providerId: selected.id, model })
      if (isCurrentVideo) setVideoPick(null)
      return
    }
    if (kind === 'video') {
      setVideoPick({ providerId: selected.id, model })
      if (isCurrentImage) setImagePick(null)
      return
    }
    if (isCurrentImage) setImagePick(null)
    if (isCurrentVideo) setVideoPick(null)
  }, [imagePick, patchProvider, selected, videoPick])

  /** 逐个模型设置显示名称；清空即回到"用模型 id 显示"。 */
  const handleChangeModelLabel = useCallback((model: string, label: string) => {
    if (selected === undefined)
      return
    const labels = { ...selected.modelLabels }
    if (label.trim() === '')
      delete labels[model]
    else
      labels[model] = label
    patchProvider(selected.id, { modelLabels: labels })
  }, [patchProvider, selected])

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-6 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在读取模型配置…
      </div>
    )
  }

  const activeLabel = active !== undefined ? providerLabel(active.displayName, active.baseUrl) : ''
  const activeModel = active?.model.trim() ?? ''

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-7 px-6 pb-14 pt-10">
      {/* 标题与状态 */}
      <div className="flex items-start gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-cyan/15 text-brand-cyan">
          <Cpu className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold tracking-tight text-foreground">AI 模型服务</h3>
            {configured
              ? (
                  <span className="flex items-center gap-1 rounded-full bg-brand-purple/10 px-2.5 py-1 text-xs font-medium text-brand-purple-deep">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    已配置你自己的模型
                  </span>
                )
              : (
                  <span className="flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700">
                    <Info className="h-3.5 w-3.5" />
                    未配置 · 需要你的钥匙
                  </span>
                )}
            {dirty && (
              <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">有未保存的改动</span>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-7 text-muted-foreground">
            {configured && active !== undefined
              ? `当前使用你自己的模型：${activeLabel} · ${activeModel !== '' ? activeModel : '—'}（接口：${displayHost(active.baseUrl)}），共 ${String(providers.length)} 个服务。AI 功能按你的账户计费。`
              : '全部 AI 均使用你自己的钥匙（按你账户计费，系统不内置任何大模型）；未配置时以内置模板回复，添加服务并填写钥匙后解锁完整创作。'}
          </p>
        </div>
      </div>

      <ProviderList
        providers={providers}
        activeId={activeId}
        editingId={selected?.id ?? ''}
        busy={saving}
        onEdit={(id) => {
          setSelectedId(id)
          setError('')
          setNotice('')
          setCandidates([])
        }}
        onSetActive={id => void handleSetActive(id)}
        onRemove={id => void handleRemove(id)}
        onAdd={handleAdd}
        renderEditor={draft => (
          <ProviderEditor
            draft={draft}
            dirty={draft.id === selected?.id && selectedDirty}
            saving={saving}
            fetching={fetching}
            showApiKey={showApiKey}
            error={error}
            notice={notice}
            onChange={patch => patchProvider(draft.id, patch)}
            onToggleApiKey={() => setShowApiKey(value => !value)}
            onFetch={() => void handleFetchModels()}
            currentMedia={{ image: imagePick, video: videoPick }}
            onSelectModel={(model, kind: ModelKind) => {
              if (kind === 'image') {
                setImagePick({ providerId: draft.id, model })
                return
              }
              if (kind === 'video') {
                setVideoPick({ providerId: draft.id, model })
                return
              }
              patchProvider(draft.id, { model })
            }}
            onRenameModel={handleRenameModel}
            onChangeModelLabel={handleChangeModelLabel}
            onChangeModelKind={handleChangeModelKind}
            onAddModel={() => patchProvider(draft.id, { models: [...draft.models, ''] })}
            onRemoveModel={(model) => {
              const models = draft.models.filter(item => item !== model)
              const labels = { ...draft.modelLabels }
              delete labels[model]
              const options = { ...draft.modelOptions }
              delete options[model]
              // 删掉的正是当前图片/视频模型时，把对应通道一起清掉，不留悬空指向。
              if (imagePick?.providerId === draft.id && imagePick.model === model)
                setImagePick(null)
              if (videoPick?.providerId === draft.id && videoPick.model === model)
                setVideoPick(null)
              patchProvider(draft.id, {
                models,
                modelLabels: labels,
                modelOptions: options,
                model: draft.model.trim() === model ? (models[0] ?? '') : draft.model,
              })
            }}
            onSave={() => void handleSave()}
            onCancel={handleCancel}
          />
        )}
      />

      <ModelPickerDialog
        open={pickerOpen}
        models={candidates}
        current={selected?.models ?? []}
        onOpenChange={(open) => {
          setPickerOpen(open)
          if (!open)
            setCandidates([])
        }}
        onConfirm={handleConfirmModels}
      />

      {/* 没有独立的媒体通道区块：图片 / 视频模型就在上面的服务目录里按用途标明。 */}
      <p className="flex items-start gap-2 px-1 text-xs leading-6 text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
        钥匙只保存在这台电脑：浏览器本地副本用于回填，本机服务写入本机 DSH 凭据文件供内核调用——不上传任何第三方；没有配置时，AI 使用内置模板回复（不含任何默认接口）。
      </p>

      {/* 常见问题 */}
      <div className="flex flex-col gap-2">
        <details className="group rounded-xl border px-5 py-4 transition-colors hover:border-border/80">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            我的钥匙安全吗？
            <span className="text-xs font-normal text-brand-cyan">了解一下</span>
          </summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            安全。钥匙只保存在你本机（浏览器副本 + 本机服务凭据文件），随请求到本机服务执行，服务器不转发第三方；所有创作与对话都按你自己的账户计费。
          </p>
        </details>
        <details className="group rounded-xl border px-5 py-4 transition-colors hover:border-border/80">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            多个服务、多个模型怎么用？
            <span className="text-xs font-normal text-brand-cyan">了解一下</span>
          </summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            可以保存多个服务（例如 Agnes 与公司网关），点「设为当前」切换全局生效的那一个；每个服务里点模型标签即可切换当前对话模型，切换后立即生效，无需重启。
          </p>
        </details>
        <details className="group rounded-xl border px-5 py-4 transition-colors hover:border-border/80">
          <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
            不配置可以吗？
            <span className="text-xs font-normal text-brand-cyan">了解一下</span>
          </summary>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            可以，但 AI 回复为内置模板（非大模型）。要解锁完整创作力，请花 3 分钟领取并填写你自己的钥匙。
          </p>
        </details>
      </div>
    </div>
  )
}

export default CustomLlmTab
