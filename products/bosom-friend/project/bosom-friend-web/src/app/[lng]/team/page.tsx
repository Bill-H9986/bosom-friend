/**
 * 管家团队页（ADR-005 呈现层改造方案 v1.0 的 N1）。
 *
 * 一屏回答"谁在干什么"：五张管家卡（身份 + 工具面 + 在办任务）、选中任务的执行时间线、
 * 待拍板清单、最近任务。数据全部来自现有只读接口，没有为这一页新增后端：
 * - 任务列表 `GET agent/tasks`（返回 `agentRole`，S1 已落地）：谁在办、办到哪一步的状态；
 * - 任务详情 `GET agent/tasks/:taskId`：消息里的 `IWorkflowStep`（时间线）与动作卡（待拍板）。
 *
 * 时间线的数据源是**任务详情里的 `stream_event` 消息**：服务端每走一步就 `task.messages.push` +
 * `files.tasks.save`（先落盘），再 SSE 转发给对话页。所以过程在任务**跑的过程中**就在库里，
 * 团队页对在办任务按 `STEP_POLL_MS` 轮询就能看到它一步步往前走，不必等这一轮收尾。
 *
 * 空态如实说"此刻还没有落到任务里的步骤"，并写明正在自动重拉——**不编一条假进度**。
 *
 * （2026-10-11 实测：store 的 `taskMessages[taskId].workflowSteps` 在任务运行中也一直是空的，
 * 所以没有把它当第二个数据源——取不到数据的通路不留在代码里假装能用。）
 *
 * 三条不造数据的规矩：
 * 1. 某个管家没有在办任务时**如实显示"暂无在办"**，不拿别的管家的任务顶上；
 * 2. `agentRole` 为 null 的旧任务**不算进任何管家**，只在下方的"未登记"说明里计数；
 * 3. 待拍板清单只扫最近若干条任务，页面上写明扫描范围，不假装它是全量。
 */
'use client'

import type { TaskDetail, TaskListItem, TaskMessage } from '@web/api/ai/ai.types'
import type { IHandoffRecord } from '@web/components/team/HandoffList'
import type { IPendingDecisionItem, ITeamAgentTaskItem } from '@web/components/team/types'
import type { IWorkflowStep } from '@web/store/agent'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { agentApi } from '@web/api/ai/ai.api'
import { PageShell } from '@web/app/layout/PageShell'
import { OneSentenceEquivalents } from '../tasks-history/components/OneSentenceEquivalents'
import { AgentRoleBadge } from '@web/components/Chat/AgentRoleBadge'
import { TaskHistoryList } from '@web/components/Chat/TaskHistoryList'
import { convertMessages } from '@web/components/Chat/utils/convertMessages'
import { AgentCard } from '@web/components/team/AgentCard'
import { ExecutionTimeline } from '@web/components/team/ExecutionTimeline'
import { HandoffList } from '@web/components/team/HandoffList'
import { PendingDecisions, classifyPendingAction } from '@web/components/team/PendingDecisions'
import { TEAM_AGENT_ROLES, isActiveTaskStatus } from '@web/components/team/roles'
import { Button } from '@web/components/ui/button'
import { useRouter } from '@web/next-shims/navigation'
import { cardSurfaceFlat } from '@web/utils/card'
import { cn } from '@web/utils/className'

/**
 * 列表接口一次拉一页，这里直接拉满。
 *
 * 任务记录页同样用 pageSize=1000（`TasksHistoryPageContent.tsx:46`）；列表接口
 * 不支持按状态过滤（`server/src/api.ts` 只认 page / pageSize / keyword / favoriteOnly），
 * 所以"谁在办"只能在本地按 `agentRole` 分组。
 */
const TASK_PAGE_SIZE = 1000

/**
 * 待拍板清单一次扫多少条任务、并发几个请求。
 *
 * 服务端没有"待办动作"的聚合接口（方案 5.4 节缺口 2），只能逐条读任务详情从消息里取动作卡。
 * 为了不让页面卡死，只扫最近这些条，并在界面上写明扫了多少条。
 */
const PENDING_SCAN_LIMIT = 12
const PENDING_SCAN_CONCURRENCY = 3

/**
 * 最近任务区显示多少条。
 *
 * 界面设计规范 v1.0 第 5 节：同一屏的卡片不超过 6 张。这里是滚动区最下面的一块，
 * 按 6 条给，一屏之内不会出现第七张卡。
 */
const RECENT_TASK_LIMIT = 6

/**
 * 任务列表的自动刷新间隔。
 *
 * 只重拉列表（一次请求）：在办的任务收尾后，卡片状态与时间线会自己跟上，
 * 不需要用户手点刷新。待拍板扫描**不**跟着轮询——那是一次十几个请求，只在进页面与手动刷新时做。
 */
const LIST_POLL_MS = 15000

/**
 * 执行时间线的自动刷新间隔（只在选中任务**正在跑**时启用）。
 *
 * 为什么必须有它：步骤是**边跑边落库**的——服务端 `emitStep` 先 `task.messages.push` 再
 * `files.tasks.save`，最后才 SSE 转发（`server/src/api.ts`）。此前这里只在"任务 id 或状态变化"
 * 时重拉，而运行中的任务状态恰好**不变**，于是时间线永远停在空态、并错误地说
 * "过程要等这一轮收尾后才落到任务里"（2026-10-11 实测：103 条任务里 66 条的 messages
 * 带 `stream_event` 工具步骤，每条都有 `createdAt`——过程在跑的时候就在库里）。
 *
 * 比列表轮询快一档：列表 15 秒是"卡片状态跟上"，时间线是"这一步走到哪了"。
 */
const STEP_POLL_MS = 5000

/**
 * 交接记录（N8）。
 *
 * 服务端目前**没有**交接记录的存储与接口：全仓检索 `handoff` 只命中发布记录里的登录方式
 * `mobile_handoff` 与几处中文注释，与规格 7.5 的六字段无关（方案 5.4 节缺口 4 已登记）。
 * 所以这里如实给空数组，界面显示空态 + 数据源待建说明。
 *
 * 这里**刻意不写一次请求**：没有端点可请求，写上去等于假装读过。数据源就位后，
 * 把这一行换成一个真实的读取即可——`HandoffList` 的六字段与渲染不用再动。
 */
const HANDOFF_RECORDS: IHandoffRecord[] = []

/** 列表项 → 团队视图任务条目。 */
function toTaskItem(task: TaskListItem): ITeamAgentTaskItem {
  return {
    id: String(task.id),
    title: task.title ?? '',
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/** 按更新时间倒序。 */
function byUpdatedDesc<T extends { updatedAt?: string, createdAt?: string }>(a: T, b: T): number {
  const left = new Date(a.updatedAt || a.createdAt || 0).getTime()
  const right = new Date(b.updatedAt || b.createdAt || 0).getTime()
  return right - left
}

/**
 * 从一条任务的历史消息里取过程步骤（时间线用）。
 *
 * 复用聊天详情页同一条转换路径 `convertMessages`：它在历史消息里把 `stream_event` /
 * `tool_use` / `tool_result` 拼成 `IWorkflowStep`，并把它合并进所属步骤。团队页另写一套
 * 解析必然与聊天页漂移，所以这里只做"拍平"。
 *
 * @param messages - 任务详情里的原始消息。
 * @returns 按发生顺序排列的步骤流。
 */
function collectWorkflowSteps(messages: TaskMessage[]): IWorkflowStep[] {
  const steps: IWorkflowStep[] = []
  for (const message of convertMessages(messages)) {
    for (const step of message.steps ?? []) {
      steps.push(...(step.workflowSteps ?? []))
    }
  }
  return steps
}

/**
 * 从一条任务里取"还没拍板"的四类动作。
 *
 * 判定只认两样**结构化事实**：动作类型属于四类（`classifyPendingAction`），
 * 且该工单在 `actionResults` 台账里没有落地（已执行 / 已核验 = 用户已经拍过板）。
 * 台账里没有记录时算"未回填"——申请过不等于做完了（DEF-248）。
 *
 * @param task - 任务详情。
 * @returns 待拍板条目（可能为空）。
 */
function collectPendingDecisions(task: TaskDetail): IPendingDecisionItem[] {
  const results = task.actionResults ?? []
  const items: IPendingDecisionItem[] = []
  const seen = new Set<string>()
  for (const message of convertMessages(task.messages ?? [])) {
    for (const action of message.actions ?? []) {
      if (classifyPendingAction(action) === null) continue
      const record = action.requestId === undefined || action.requestId === ''
        ? undefined
        : results.find(entry => entry.requestId === action.requestId)
      if (record !== undefined && (record.state === 'executed' || record.state === 'verified')) continue
      const key = `${action.requestId ?? action.type}-${action.title ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        taskId: String(task.id),
        taskTitle: task.title ?? '',
        agentRole: task.agentRole ?? null,
        updatedAt: task.updatedAt,
        action,
        actionResults: results,
      })
    }
  }
  return items
}

/** 并发扫描最近若干条任务，收集待拍板动作。 */
async function scanPendingDecisions(tasks: TaskListItem[]): Promise<{ items: IPendingDecisionItem[], scanned: number }> {
  const candidates = [...tasks].sort(byUpdatedDesc).slice(0, PENDING_SCAN_LIMIT)
  const items: IPendingDecisionItem[] = []
  let cursor = 0
  const worker = async () => {
    while (cursor < candidates.length) {
      const task = candidates[cursor]
      cursor += 1
      try {
        const res = await agentApi.getTaskDetail(String(task.id))
        if (res?.code === 0 && res.data !== undefined && res.data !== null) {
          items.push(...collectPendingDecisions(res.data))
        }
      }
      catch {
        // 单条任务读不到不该让整份清单消失：跳过它，清单上如实少这一条。
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PENDING_SCAN_CONCURRENCY, candidates.length) }, () => worker()),
  )
  return { items, scanned: candidates.length }
}

export default function TeamPage() {
  const router = useRouter()

  const [tasks, setTasks] = useState<TaskListItem[]>([])
  const [isLoadingTasks, setIsLoadingTasks] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [historySteps, setHistorySteps] = useState<IWorkflowStep[]>([])
  const [isLoadingSteps, setIsLoadingSteps] = useState(false)

  const [pendingItems, setPendingItems] = useState<IPendingDecisionItem[]>([])
  const [isScanningPending, setIsScanningPending] = useState(true)
  const [pendingScanned, setPendingScanned] = useState(0)

  /** 只拉任务列表（轮询用）：一次请求，不触发待拍板扫描。 */
  const loadTasks = useCallback(async (): Promise<TaskListItem[] | null> => {
    setIsLoadingTasks(true)
    setLoadError('')
    try {
      const res = await agentApi.getTaskList({ page: 1, pageSize: TASK_PAGE_SIZE })
      if (res?.code === 0 && res.data) {
        const list = res.data.list ?? []
        setTasks(list)
        return list
      }
      setTasks([])
      setLoadError('任务列表没读出来，稍后再试一次。')
      return null
    }
    catch {
      setTasks([])
      setLoadError('任务列表没读出来，稍后再试一次。')
      return null
    }
    finally {
      setIsLoadingTasks(false)
    }
  }, [])

  /** 扫描待拍板动作（进页面与手动刷新时做，不跟着轮询）。 */
  const scanPending = useCallback(async (list: TaskListItem[]) => {
    setIsScanningPending(true)
    try {
      const scanned = await scanPendingDecisions(list)
      setPendingItems(scanned.items)
      setPendingScanned(scanned.scanned)
    }
    finally {
      setIsScanningPending(false)
    }
  }, [])

  /** 进页面 / 点刷新：列表 + 待拍板一起更新。 */
  const refreshAll = useCallback(async () => {
    const list = await loadTasks()
    if (list !== null) await scanPending(list)
  }, [loadTasks, scanPending])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // 进页面后定期重拉列表：在办任务收尾后，卡片状态与时间线自己跟上，不用手点刷新。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTasks()
    }, LIST_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadTasks])

  /** 每个管家在办的任务（`agentRole` 精确匹配，未登记的旧任务不归任何人）。 */
  const activeTasksByRole = useMemo(() => {
    const map = new Map<string, ITeamAgentTaskItem[]>()
    for (const role of TEAM_AGENT_ROLES) map.set(role.code, [])
    for (const task of tasks) {
      if (!isActiveTaskStatus(task.status)) continue
      const code = (task.agentRole ?? '').trim()
      const bucket = map.get(code)
      if (bucket !== undefined) bucket.push(toTaskItem(task))
    }
    for (const bucket of map.values()) bucket.sort(byUpdatedDesc)
    return map
  }, [tasks])

  /** 每个管家最近一次动作（不限状态）。 */
  const latestTaskByRole = useMemo(() => {
    const map = new Map<string, ITeamAgentTaskItem>()
    for (const task of [...tasks].sort(byUpdatedDesc)) {
      const code = (task.agentRole ?? '').trim()
      if (code !== '' && !map.has(code)) map.set(code, toTaskItem(task))
    }
    return map
  }, [tasks])

  const activeCount = useMemo(
    () => [...activeTasksByRole.values()].reduce((sum, bucket) => sum + bucket.length, 0),
    [activeTasksByRole],
  )

  /** 未登记归属的任务数：旧任务没有 `agentRole` 字段，界面不猜它归谁。 */
  const unregisteredCount = useMemo(
    () => tasks.filter(task => (task.agentRole ?? '').trim() === '').length,
    [tasks],
  )

  /** 默认选中：第一条在办任务；一条在办都没有时退到最近更新的一条（过程仍然看得见）。 */
  useEffect(() => {
    if (tasks.length === 0) return
    setSelectedTaskId((current) => {
      if (current !== '' && tasks.some(task => String(task.id) === current)) return current
      const active = [...tasks].sort(byUpdatedDesc).find(task => isActiveTaskStatus(task.status))
      if (active !== undefined) return String(active.id)
      const latest = [...tasks].sort(byUpdatedDesc)[0]
      return latest === undefined ? '' : String(latest.id)
    })
  }, [tasks])

  const selectedTask = useMemo(
    () => tasks.find(task => String(task.id) === selectedTaskId),
    [tasks, selectedTaskId],
  )
  const selectedTaskStatus = selectedTask?.status ?? ''
  const isSelectedActive = isActiveTaskStatus(selectedTaskStatus)

  /**
   * 执行时间线：读任务详情里的 `stream_event` 步骤。
   *
   * 在办任务按 `STEP_POLL_MS` 轮询——步骤是边跑边落库的，不轮询就会一直停在空态；
   * 跑完的任务只按状态变化重拉一次（终态不会再变，没必要继续轮询）。
   */
  useEffect(() => {
    if (selectedTaskId === '') {
      setHistorySteps([])
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const res = await agentApi.getTaskDetail(selectedTaskId)
        if (cancelled) return
        setHistorySteps(res?.code === 0 && res.data ? collectWorkflowSteps(res.data.messages ?? []) : [])
      }
      catch {
        if (!cancelled) setHistorySteps([])
      }
      finally {
        if (!cancelled) setIsLoadingSteps(false)
      }
    }
    setIsLoadingSteps(true)
    void load()
    const timer = isSelectedActive ? window.setInterval(() => void load(), STEP_POLL_MS) : null
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
    }
  }, [selectedTaskId, selectedTaskStatus, isSelectedActive])

  const recentTasks = useMemo(() => [...tasks].sort(byUpdatedDesc).slice(0, RECENT_TASK_LIMIT), [tasks])

  const pendingScopeNote = pendingScanned === 0
    ? '还没有任务可扫。'
    : `已扫最近 ${pendingScanned} 条任务，未回填的四类动作都在这里。`

  /**
   * 时间线为空时的说法分两种：正在跑（过程还没落库）/ 跑完但没留下过程。
   * 两种都不许含糊成"没有步骤"。
   */
  const timelineEmptyText = isSelectedActive
    ? `这条任务正在跑，此刻还没有落到任务里的步骤（每 ${STEP_POLL_MS / 1000} 秒自动重拉一次）。点「去这条对话」看它此刻在做什么。`
    : '这条任务没有留下可看的步骤（历史任务的过程没有落库）。'

  return (
    <PageShell
      title="管家团队"
      actions={(
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refreshAll()}
          disabled={isLoadingTasks}
          className="cursor-pointer gap-2"
        >
          <RefreshCw className={cn('h-4 w-4', isLoadingTasks && 'animate-spin')} />
          刷新
        </Button>
      )}
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <OneSentenceEquivalents page="team" />
        {/* 一句话说清这页在回答什么 */}
        <p className="text-[15px] text-muted-foreground">
          一个总管 + 四个管家。下面每张卡是「谁在办什么」；点一条在办任务，看它干到哪、卡在哪。
        </p>

        {loadError !== '' && (
          <div className={cn(cardSurfaceFlat, 'border-destructive/40 p-6')}>
            <p className="text-sm text-destructive">{loadError}</p>
            <Button variant="outline" size="sm" className="mt-2 cursor-pointer" onClick={() => void refreshAll()}>
              再试一次
            </Button>
          </div>
        )}

        {/* 五张管家卡 */}
        <section className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
          {TEAM_AGENT_ROLES.map(role => (
            <AgentCard
              key={role.code}
              role={role}
              activeTasks={activeTasksByRole.get(role.code) ?? []}
              latestTask={latestTaskByRole.get(role.code)}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          ))}
        </section>

        <p className="text-[13px] text-muted-foreground">
          共
          {' '}
          {activeCount}
          {' '}
          条任务在办；另有
          {' '}
          {unregisteredCount}
          {' '}
          条任务未登记归属管家（早于归属字段的旧任务），没有算进上面五个管家。
        </p>

        {/* 执行时间线 */}
        <section className={cn(cardSurfaceFlat, 'flex flex-col gap-6 p-6')}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">执行时间线</h2>
            {selectedTask !== undefined && (
              <>
                <AgentRoleBadge agentRole={selectedTask.agentRole} />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={selectedTask.title}>
                  {selectedTask.title || '未命名任务'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={() => router.push(`/chat/${selectedTaskId}`)}
                >
                  去这条对话
                </Button>
              </>
            )}
          </div>
          {selectedTask === undefined
            ? (
                <p className="text-xs text-muted-foreground">
                  {isLoadingTasks ? '正在读任务…' : '还没有任务。去对话里说一句话，这里就会出现它干到哪。'}
                </p>
              )
            : (
                <ExecutionTimeline
                  steps={historySteps}
                  isLoading={isLoadingSteps}
                  emptyText={timelineEmptyText}
                />
              )}
        </section>

        {/* 待拍板清单 */}
        <section className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">等你拍板</h2>
          <PendingDecisions
            items={pendingItems}
            isLoading={isScanningPending}
            scopeNote={pendingScopeNote}
            onOpenTask={taskId => router.push(`/chat/${taskId}`)}
          />
        </section>

        {/* 历史区（M5）：最近 6 条在这里，全量在「任务记录」页——那页是本区的完整视图，
            所以这里必须给一个明确出口，否则用户以为团队页只有这几条。 */}
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">历史</h2>
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => router.push('/tasks-history')}
            >
              查看全部任务记录
            </Button>
          </div>
          <TaskHistoryList
            tasks={recentTasks}
            isLoading={isLoadingTasks}
            skeletonCount={4}
            batchSelectable={false}
            onRefresh={() => refreshAll()}
          />
        </section>

        {/* 交接记录（N8）：六字段视图，当前无数据源，如实显示空态 */}
        <HandoffList records={HANDOFF_RECORDS} />
      </div>
    </PageShell>
  )
}
