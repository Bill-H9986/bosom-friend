/**
 * HandoffList - 交接记录视图（ADR-005 呈现层改造方案 v1.0 的 N8）。
 *
 * 字段口径来自《管家 preset 与 Skills 规格 v1.0》第 7.5 节「交接记录格式（可判定）」，
 * 六字段缺一不可：**时间 / 从 → 到 / 对象 / 已完成 / 待办 / 结果**。
 *
 * ## 为什么这里现在只有空态
 *
 * 全仓检索后确认：**交接记录目前没有数据源**——服务端没有存储、没有接口，
 * 内核与 presets 里也没有落点（《呈现层改造方案 v1.0》第 5.4 节缺口 4 已如实登记）。
 * 所以这一版只交付**视图与字段位**：
 * - 空态如实说「暂无可显示的交接记录」，并写明数据源待建；
 * - **不造一条示例记录**——一条假记录会让「交接可判定」（规格 V5）变成假绿。
 *
 * 数据源就位后要改的只有一处：把 `HANDOFF_DATA_SOURCE_READY` 置为 true，
 * 由调用方把真实记录传进 `records`。字段与渲染已经按 7.5 摆好，不需要再动界面。
 */
'use client'

import { cn } from '@web/utils/className'
import { cardSurfaceFlat } from '@web/utils/card'

/**
 * 交接记录的数据源是否已就位。
 *
 * 当前为 false：后端既没有存储也没有接口（见文件头说明）。置为 true 时组件会显示
 * 「等待记录」以外的正常渲染路径，调用方必须同时保证 `records` 来自真实接口。
 */
export const HANDOFF_DATA_SOURCE_READY = false

/** 一条交接记录：与规格 7.5 的六字段一一对应。 */
export interface IHandoffRecord {
  /** 记录标识（列表 key）。 */
  id: string
  /** 字段一·时间：时间戳（本地时区）。 */
  at: string
  /** 字段二·从：发起管家。 */
  fromRole: string
  /** 字段二·到：接收方（管家或用户）。 */
  toRole: string
  /** 字段三·对象：对象类型（草稿 / 素材 / 账号 / 作品）。 */
  objectType: string
  /** 字段三·对象：对象标识（draftId / materialId / accountId / 平台作品 ID）。 */
  objectId: string
  /** 字段四·已完成：发起方做完了哪几步。 */
  done: string[]
  /** 字段五·待办：接收方要做什么。 */
  todo: string
  /** 字段六·结果：成功带作品 ID，失败带原因。 */
  result: {
    /** true = 接收方回报成功；false = 失败或未回报。 */
    ok: boolean
    /** 成功写结果标识，失败写原因。 */
    text: string
  }
}

/** 六字段的列头，顺序与规格 7.5 的表格一致。 */
const HANDOFF_COLUMNS = ['时间', '从 → 到', '对象', '已完成', '待办', '结果'] as const

export interface HandoffListProps {
  /** 真实交接记录；数据源未就位时传空数组，界面如实显示空态。 */
  records: IHandoffRecord[]
  /** 是否正在读取。 */
  isLoading?: boolean
  /** 空态主文案。 */
  emptyText?: string
  /** 空态补充说明（默认按「数据源待建」如实说明）。 */
  emptyHint?: string
  /** 外层附加类名。 */
  className?: string
}

/**
 * 交接记录列表：按规格 7.5 的六字段展示跨管家交接。
 *
 * @param props.records - 真实交接记录（空数组时显示空态）。
 * @param props.isLoading - 是否正在读取。
 * @param props.emptyText - 空态主文案。
 * @param props.emptyHint - 空态补充说明。
 * @param props.className - 外层附加类名。
 */
export function HandoffList({
  records,
  isLoading = false,
  emptyText = '暂无可显示的交接记录',
  emptyHint,
  className,
}: HandoffListProps) {
  const hasRecords = records.length > 0
  const hint = emptyHint
    ?? (HANDOFF_DATA_SOURCE_READY
      ? '数据源已就位，但当前窗口内还没有交接发生。'
      : '数据源待建：后端还没有交接记录的存储与接口（《管家 preset 与 Skills 规格 v1.0》第 7.5 节要求的六字段目前没有落点，见《呈现层改造方案 v1.0》第 5.4 节缺口 4）。这一版只交付视图与字段位，数据源一就位就会显示真实记录——在它之前不会用假记录填充。')

  return (
    <section className={cn(cardSurfaceFlat, 'flex flex-col gap-6 p-6', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">交接记录</h2>
        <span className="text-[13px] text-muted-foreground">
          跨管家移交按规格 7.5 记六字段：时间 / 从 → 到 / 对象 / 已完成 / 待办 / 结果
        </span>
      </div>

      {/* 列头常驻：即使没有记录，六字段的位子也看得见，便于对照规格核验。 */}
      <div className="hidden grid-cols-12 gap-3 border-b border-border pb-3 md:grid">
        <span className="col-span-2 text-[13px] text-muted-foreground">{HANDOFF_COLUMNS[0]}</span>
        <span className="col-span-1 text-[13px] text-muted-foreground">{HANDOFF_COLUMNS[1]}</span>
        <span className="col-span-2 text-[13px] text-muted-foreground">{HANDOFF_COLUMNS[2]}</span>
        <span className="col-span-3 text-[13px] text-muted-foreground">{HANDOFF_COLUMNS[3]}</span>
        <span className="col-span-2 text-[13px] text-muted-foreground">{HANDOFF_COLUMNS[4]}</span>
        <span className="col-span-2 text-[13px] text-muted-foreground">{HANDOFF_COLUMNS[5]}</span>
      </div>

      {isLoading
        ? (
            <p className="text-[13px] text-muted-foreground">正在读交接记录…</p>
          )
        : !hasRecords
            ? (
                <div className="flex flex-col gap-2 rounded-2xl border border-dashed border-border p-6">
                  <p className="text-[15px] text-foreground">{emptyText}</p>
                  <p className="text-[13px] text-muted-foreground">{hint}</p>
                </div>
              )
            : (
                <ul className="flex flex-col gap-3">
                  {records.map(record => (
                    <li
                      key={record.id}
                      className="grid grid-cols-1 gap-3 rounded-2xl border border-border px-6 py-4 md:grid-cols-12"
                    >
                      <span className="col-span-2 text-[13px] text-muted-foreground">{record.at}</span>
                      <span className="col-span-1 text-[15px] text-foreground">
                        {record.fromRole}
                        {' → '}
                        {record.toRole}
                      </span>
                      <span className="col-span-2 text-[15px] text-foreground">
                        {record.objectType}
                        {' '}
                        <span className="text-[13px] text-muted-foreground">{record.objectId}</span>
                      </span>
                      <span className="col-span-3 text-[15px] text-foreground">
                        {record.done.length === 0 ? '—' : record.done.join('、')}
                      </span>
                      <span className="col-span-2 text-[15px] text-foreground">{record.todo}</span>
                      <span
                        className={cn(
                          'col-span-2 text-[15px]',
                          record.result.ok ? 'text-foreground' : 'text-destructive',
                        )}
                      >
                        {record.result.ok ? '成功' : '失败'}
                        {record.result.text === '' ? '' : `（${record.result.text}）`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
    </section>
  )
}

export default HandoffList
