/**
 * ProviderList - 设置 → 自定义大模型：服务卡片列表。
 *
 * 每个服务一张卡：抬头一行给名称 / 状态点 / 徽标与「编辑」「删除」，
 * 点「编辑」就地展开编辑区并替换掉「编辑」按钮（同一时刻只展开一个）。
 * 版式对齐 DSH 的模型设置：展开态用换色 + 描边表示而不是增高动画。
 */
'use client'

import type { ReactNode } from 'react'
import { Check, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@web/components/ui/button'
import { cn } from '@web/utils/className'
import { displayHost, openAgnesApplyPage, providerLabel, type ProviderDraft } from './types'

interface ProviderListProps {
  providers: ProviderDraft[]
  /** 全局生效的服务 id。 */
  activeId: string
  /** 正在编辑的服务 id；空串表示全部收起。 */
  editingId: string
  onEdit: (id: string) => void
  onSetActive: (id: string) => void
  onRemove: (id: string) => void
  onAdd: () => void
  /** 保存 / 切换进行中：禁用行内动作，避免并发提交。 */
  busy: boolean
  /** 展开卡的编辑区，由调用方按正在编辑的服务渲染。 */
  renderEditor: (draft: ProviderDraft) => ReactNode
}

/** 状态徽标：统一字号与圆角，颜色区分「当前使用 / 未保存 / 缺密钥」。 */
function Tag({ tone, children }: { tone: 'active' | 'draft' | 'warn', children: string }) {
  const tones = {
    active: 'bg-brand-purple/10 text-brand-purple-deep',
    draft: 'bg-muted text-muted-foreground',
    warn: 'bg-amber-500/10 text-amber-700',
  }
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', tones[tone])}>{children}</span>
}

/** 未配置任何服务时的领取钥匙引导。 */
function EmptyGuide() {
  return (
    <div className="mt-4 rounded-xl border border-dashed px-4 py-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {['注册 Agnes 账号', '创建并复制你的 API Key', '粘贴到左边并保存'].map((step, index) => (
          <span key={step} className="flex items-center gap-2">
            {index > 0 && <span className="text-muted-foreground/60">→</span>}
            <span className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-muted-foreground">
              <span className="flex h-4 w-4 items-center justify-center rounded-full bg-brand-purple text-[10px] font-bold text-white">{index + 1}</span>
              {step}
            </span>
          </span>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        点右上角「Agnes AI 国内站」注册并领取钥匙，再回来点「添加模型服务」。
      </p>
    </div>
  )
}

export function ProviderList({
  providers, activeId, editingId, onEdit, onSetActive, onRemove, onAdd, busy, renderEditor,
}: ProviderListProps) {
  const [confirmId, setConfirmId] = useState('')

  return (
    <section className="rounded-2xl border bg-card/40 p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">我的模型服务</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            可保存多个服务（如 Agnes、公司网关、其他 OpenAI 兼容接口）；点「编辑」就地修改，圆点选中的是全局生效的那一个。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* 还没有钥匙的用户从这里去官网，而不是给他预建一条"Agnes AI（未保存）"的配置 */}
          <Button variant="outline" size="sm" className="cursor-pointer" onClick={openAgnesApplyPage}>
            <ExternalLink className="mr-1.5 h-4 w-4" />
            Agnes AI 国内站
          </Button>
          <Button variant="outline" size="sm" disabled={busy} className="cursor-pointer" onClick={onAdd}>
            <Plus className="mr-1.5 h-4 w-4" />
            添加模型服务
          </Button>
        </div>
      </div>

      {providers.length === 0
        ? <EmptyGuide />
        : (
            <ul data-testid="llm-provider-list" className="mt-4 flex list-none flex-col gap-2.5 p-0">
              {providers.map((draft) => {
                const label = providerLabel(draft.displayName, draft.baseUrl)
                const isActive = draft.id === activeId
                const open = draft.id === editingId
                const missingKey = draft.apiKey.trim() === '' && !draft.hasApiKey
                const detailId = 'bf-llm-detail-' + draft.id
                return (
                  <li
                    key={draft.id}
                    data-testid="llm-provider-item"
                    data-open={open ? 'true' : undefined}
                    className={cn(
                      'overflow-hidden rounded-xl border bg-card transition-colors',
                      open ? 'border-brand-cyan/50 shadow-sm' : 'border-border hover:border-border/80',
                    )}
                  >
                    <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-3">
                      <span
                        aria-hidden="true"
                        title={missingKey ? '缺密钥' : '已配置密钥'}
                        className={cn(
                          'h-2 w-2 shrink-0 rounded-full',
                          missingKey ? 'bg-amber-500' : 'bg-emerald-500',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">{label}</span>
                          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">自定义</span>
                          {isActive && <Tag tone="active">当前使用</Tag>}
                          {draft.isNew && <Tag tone="draft">未保存</Tag>}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {displayHost(draft.baseUrl)}
                          {' · '}
                          {draft.model.trim() !== '' ? draft.model.trim() : '未选模型'}
                          {' · '}
                          {'共 ' + String(draft.models.filter(model => model.trim() !== '').length) + ' 个模型'}
                        </span>
                      </span>

                      <span className="flex shrink-0 items-center gap-1.5">
                        {confirmId === draft.id
                          ? (
                              <>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  disabled={busy}
                                  className="cursor-pointer"
                                  onClick={() => { setConfirmId(''); onRemove(draft.id) }}
                                >
                                  确认删除
                                </Button>
                                <Button variant="ghost" size="sm" className="cursor-pointer" onClick={() => setConfirmId('')}>
                                  取消
                                </Button>
                              </>
                            )
                          : (
                              <>
                                {!isActive && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    className="cursor-pointer"
                                    onClick={() => onSetActive(draft.id)}
                                  >
                                    <Check className="mr-1 h-3.5 w-3.5" />
                                    设为当前
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  aria-expanded={open}
                                  aria-controls={detailId}
                                  className="cursor-pointer"
                                  onClick={() => onEdit(open ? '' : draft.id)}
                                >
                                  {open ? '收起' : '编辑'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="删除该服务"
                                  aria-label={'删除 ' + label}
                                  disabled={busy}
                                  className="cursor-pointer text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  onClick={() => setConfirmId(draft.id)}
                                >
                                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                                  删除
                                </Button>
                              </>
                            )}
                      </span>
                    </div>

                    {open && (
                      <div id={detailId} className="border-t border-border bg-background/40 px-4 pb-4 pt-3">
                        {renderEditor(draft)}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
    </section>
  )
}

export default ProviderList
