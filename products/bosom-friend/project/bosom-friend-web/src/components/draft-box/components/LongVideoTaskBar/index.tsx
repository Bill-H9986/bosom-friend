/**
 * LongVideoTaskBar - 内容创作页上的长片进度条
 *
 * 为什么它必须在创作页里：长片就是**这一页**的时长档发起的（≥90 秒走分段），
 * 但它的进度在 long-videos 任务里、不在生成记录里——发起之后页面上什么都看不到，
 * "跑到第几镜了、要不要从断点继续"只能靠问 AI 或者去数据根翻文件。
 * 2026-09-30 现场：一条 18/21 镜的片子停在盘上一整夜，页面上完全看不出来；
 * 用户当时的原话是"创作的新视频呢？？？？"。
 *
 * 只显示"**正在跑**"的：跑完的片子已经进素材库，不需要这条常驻占地方；
 * **跑了一半失败的（"已中断，可续跑"）也不再显示**（2026-10-13 产品负责人当场指出：
 * 截图里三条"已中断，可续跑"堆在创作页上，他说「这个不要！」）——
 * 理由：这条存在的意义是"让用户看到长片**正在跑**"，而失败品常驻只会碍眼；
 * **要续跑就问 AI 一句话**（"把那条片子从断点接着跑"），那正是"一句话办事"，不需要这里常驻按钮。
 * 没有任务时整条不渲染。
 */
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Clapperboard, Loader2, RotateCcw, Square } from 'lucide-react'
import { listLongVideoTasks, resumeLongVideoTask, stopLongVideoTask, type LongVideoTask } from '@web/api/longVideo/longVideo.api'
import { Button } from '@web/components/ui/button'
import { toast } from '@web/utils/ui/toast'

export function LongVideoTaskBar() {
  const [tasks, setTasks] = useState<LongVideoTask[]>([])
  const [busyId, setBusyId] = useState('')

  const refresh = useCallback(async () => {
    try {
      // 返回的是**信封**（`{ code, data: { list } }`）：列表在 data 里，照抄既有的
      // LongVideoPage.refreshHistory 口径。写成 `res.list` 会永远取到 undefined——
      // 组件静默不渲染，看起来像"没做"，实际只是读错了一层（2026-09-30 实测：
      // 页面里 count=0，而任务明明失败着等续跑）。
      const res = await listLongVideoTasks()
      const list = res?.data?.list
      if (!Array.isArray(list)) {
        setTasks([])
        return
      }
      // 2026-10-13：只留"正在跑"的。原来还带 `failed && doneSegments > 0`（已中断可续跑），
      // 产品负责人看到三条失败品常驻在创作页上，明确说「这个不要！」。
      setTasks(list.filter(task => task.status === 'generating'))
    }
    catch {
      // 读不到就整条不显示：这是"顺带看得见"的一条，不该让创作页因为它报错。
      setTasks([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 只在真有任务在跑时轮询：没任务就不必每 15 秒打一次接口。
  useEffect(() => {
    if (!tasks.some(task => task.status === 'generating')) return undefined
    const timer = setInterval(() => { void refresh() }, 15000)
    return () => clearInterval(timer)
  }, [tasks, refresh])

  const act = async (id: string, kind: 'resume' | 'stop'): Promise<void> => {
    setBusyId(id)
    try {
      if (kind === 'resume') {
        await resumeLongVideoTask(id)
        toast.success('已从断点继续：只补没跑成的镜，已生成的镜保留')
      }
      else {
        await stopLongVideoTask(id)
        toast.success('已停止：已跑成的镜保留，想接着跑可以点「断点继续」')
      }
      await refresh()
    }
    catch (error) {
      toast.error((kind === 'resume' ? '续跑失败：' : '停止失败：') + String(error))
    }
    finally {
      setBusyId('')
    }
  }

/**
 * 把任务记录里的失败文案翻成一盏状态灯。
 *
 * 为什么要有它：2026-10-11 现场，任务在「厂商限速中，90 秒一轮重试」和「真的卡死」之间，
 * 页面上完全看不出区别——用户只能干等或去翻数据文件。厂商的拒绝类型其实已经由编排层写进
 * errorMessage（限流 / 排队过久 / 队列已满三种，等待量级分别是 90 秒 / 15 分钟 / 30 分钟），
 * 这里只负责把它显示出来。
 *
 * @param task - 长片任务记录。
 * @returns 状态灯文案与配色；没有可报的状态时返回 null。
 */
function channelNote(task: LongVideoTask): { text: string; tone: string; dot: string } | null {
  const msg = task.errorMessage ?? ''
  if (msg === '') return null
  if (msg.includes('队列已满')) return { text: msg, tone: 'text-orange-600', dot: 'bg-orange-500' }
  if (msg.includes('排队过久')) return { text: msg, tone: 'text-amber-600', dot: 'bg-amber-500' }
  if (msg.includes('限流')) return { text: msg, tone: 'text-yellow-600', dot: 'bg-yellow-500' }
  return { text: msg, tone: 'text-muted-foreground', dot: 'bg-muted-foreground' }
}

  if (tasks.length === 0) return null

  return (
    <div className="flex flex-col gap-2 border-b px-4 py-3" data-testid="long-video-task-bar">
      {tasks.map((task) => {
        const total = Math.max(1, task.totalSegments ?? 0)
        const done = task.doneSegments ?? 0
        const percent = Math.min(100, Math.round((done / total) * 100))
        const running = task.status === 'generating'
        return (
          <div
            key={task.id}
            className="flex items-center gap-3 rounded-xl border bg-card px-4 py-2.5"
            data-testid={'long-video-task-' + task.id}
          >
            <Clapperboard className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="font-medium">{running ? '出片中' : '已中断，可续跑'}</span>
                <span className="text-muted-foreground">
                  {done}/{task.totalSegments} 镜 · 目标 {task.targetSeconds} 秒
                </span>
                {running && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
              {/* 通道状态灯：一眼分清「在等窗口」与「真卡死」。 */}
              {running && channelNote(task) !== null && (
                <div className={'mt-1 flex items-center gap-1.5 text-[11px] ' + channelNote(task)!.tone}>
                  <span className={'inline-block h-1.5 w-1.5 shrink-0 rounded-full ' + channelNote(task)!.dot} />
                  <span className="truncate">{channelNote(task)!.text}</span>
                </div>
              )}
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: String(percent) + '%' }} />
              </div>
            </div>
            {running
              ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === task.id}
                    data-testid={'long-video-stop-' + task.id}
                    onClick={() => { void act(task.id, 'stop') }}
                  >
                    <Square className="mr-1 h-3.5 w-3.5" />停止
                  </Button>
                )
              : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === task.id}
                    data-testid={'long-video-resume-' + task.id}
                    onClick={() => { void act(task.id, 'resume') }}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />断点继续
                  </Button>
                )}
          </div>
        )
      })}
    </div>
  )
}

export default LongVideoTaskBar
