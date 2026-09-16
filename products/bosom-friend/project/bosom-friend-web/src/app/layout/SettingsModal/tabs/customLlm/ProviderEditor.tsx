/**
 * ProviderEditor - 设置 → 自定义大模型：收纳卡展开后的编辑区。
 *
 * 版式对齐 DSH 的模型设置：标题行（服务名 + 服务 id）→ API 密钥 → 可折叠的
 * 「自定义设置」（显示名称 / API 地址 / API 协议 / 模型目录）→ 取消 / 保存。
 * 自身不画外框与标题：外层收纳卡已经提供了边框、名称与展开态。
 */
'use client'

import type { ReactNode } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import { Label } from '@web/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@web/components/ui/select'
import { cn } from '@web/utils/className'
import {
  MODEL_KIND_LABELS,
  modelKind,
  PROVIDER_PROTOCOLS,
  providerLabel,
  type MediaPick,
  type ModelKind,
  type ProviderDraft,
} from './types'

interface ProviderEditorProps {
  draft: ProviderDraft
  /** 有未保存改动时可取消（新增服务为放弃这次填写，已存服务为还原）。 */
  dirty: boolean
  saving: boolean
  fetching: boolean
  showApiKey: boolean
  error: string
  notice: string
  onChange: (patch: Partial<ProviderDraft>) => void
  onToggleApiKey: () => void
  /** 打开「选择要添加的模型」弹窗（先由调用方拉取可用模型）。 */
  onFetch: () => void
  /** 选中"当前使用"：对话模型落在服务上，图片 / 视频模型落在对应通道上。 */
  onSelectModel: (model: string, kind: ModelKind) => void
  /** 当前图片 / 视频模型，用于给对应行点亮圆点。 */
  currentMedia: { image: MediaPick | null, video: MediaPick | null }
  onRenameModel: (from: string, to: string) => void
  onChangeModelLabel: (model: string, label: string) => void
  /** 改模型用途（对话 / 图片 / 视频）——图片与视频模型不再另开配置区。 */
  onChangeModelKind: (model: string, kind: ModelKind) => void
  onRemoveModel: (model: string) => void
  onAddModel: () => void
  onSave: () => void
  onCancel: () => void
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

/** 模型目录里的一行：当前模型单选 + 模型 id + 显示名称 + 删除。 */
function ModelRow({ model, label, kind, current, onSelect, onRename, onChangeLabel, onChangeKind, onRemove }: {
  model: string
  label: string
  kind: ModelKind
  current: boolean
  onSelect: () => void
  onRename: (value: string) => void
  onChangeLabel: (value: string) => void
  onChangeKind: (kind: ModelKind) => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        title={current ? '当前对话模型' : '设为当前对话模型'}
        aria-label={current ? '当前对话模型' : '设为当前对话模型'}
        aria-pressed={current}
        className={cn(
          'flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-colors',
          current ? 'border-brand-cyan' : 'border-muted-foreground/40 hover:border-brand-cyan/60',
        )}
        onClick={onSelect}
      >
        {current && <span className="h-2 w-2 rounded-full bg-brand-cyan" />}
      </button>
      <Input
        value={model}
        placeholder="模型 id，例如 agnes-2.5-flash"
        autoComplete="off"
        className="h-9 flex-1"
        onChange={event => onRename(event.target.value)}
      />
      <Select value={kind} onValueChange={value => onChangeKind(value as ModelKind)}>
        <SelectTrigger className="h-9 w-[104px] shrink-0 cursor-pointer" aria-label="模型用途">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(MODEL_KIND_LABELS) as ModelKind[]).map(item => (
            <SelectItem key={item} value={item} className="cursor-pointer">
              {MODEL_KIND_LABELS[item]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        value={label}
        placeholder="显示名称"
        autoComplete="off"
        className="h-9 flex-1"
        onChange={event => onChangeLabel(event.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title="从目录移除"
        aria-label={'从目录移除 ' + model}
        className="shrink-0 cursor-pointer text-muted-foreground hover:text-destructive"
        onClick={onRemove}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  )
}

export function ProviderEditor({
  draft, dirty, saving, fetching, showApiKey, error, notice,
  onChange, onToggleApiKey, onFetch, onSelectModel, currentMedia, onRenameModel, onChangeModelLabel,
  onChangeModelKind, onRemoveModel, onAddModel, onSave, onCancel,
}: ProviderEditorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const label = providerLabel(draft.displayName, draft.baseUrl)
  const missingKey = draft.apiKey.trim() === '' && !draft.hasApiKey
  const catalog = draft.models
  /** 圆点点亮规则：对话看服务的当前模型，图片 / 视频看对应通道的归属。 */
  const isCurrentModel = (model: string, kind: ModelKind) => {
    if (kind === 'chat')
      return draft.model.trim() === model
    const pick = kind === 'image' ? currentMedia.image : currentMedia.video
    return pick !== null && pick.providerId === draft.id && pick.model === model
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{draft.id}</span>
      </div>

      <div className="flex flex-col gap-5 pt-4">
        <Field
          label="API 密钥"
          htmlFor="bf-llm-api-key"
          hint={missingKey ? '该服务还没有密钥，填好后点下方「保存」' : undefined}
        >
          <div className="relative">
            <Input
              id="bf-llm-api-key"
              type={showApiKey ? 'text' : 'password'}
              value={draft.apiKey}
              placeholder={draft.hasApiKey ? 'sk-...（留空沿用已保存的钥匙）' : 'sk-...'}
              autoComplete="off"
              className="pr-10"
              onChange={event => onChange({ apiKey: event.target.value })}
            />
            <button
              type="button"
              aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
              title={showApiKey ? '隐藏' : '显示'}
              className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={onToggleApiKey}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        {/* 高级项默认收起：多数用户只需要填一把钥匙 */}
        <div className="rounded-xl border border-dashed">
          <button
            type="button"
            aria-expanded={advancedOpen}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-foreground"
            onClick={() => setAdvancedOpen(value => !value)}
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[140ms] ease-in-out motion-reduce:transition-none',
                advancedOpen && 'rotate-180',
              )}
            />
            自定义设置
          </button>
          {advancedOpen && (
            <div className="flex flex-col gap-5 border-t border-dashed px-3 pb-4 pt-4">
              <Field label="显示名称" htmlFor="bf-llm-display-name" hint="用于区分多个服务；留空按接口地址自动命名为 Agnes AI / 自定义模型">
                <Input
                  id="bf-llm-display-name"
                  value={draft.displayName}
                  placeholder={label}
                  autoComplete="off"
                  onChange={event => onChange({ displayName: event.target.value })}
                />
              </Field>

              <Field label="API 地址" htmlFor="bf-llm-base-url" hint="OpenAI 兼容接口，一般以 /v1 结尾">
                <Input
                  id="bf-llm-base-url"
                  value={draft.baseUrl}
                  placeholder="https://api.agnes-ai.cn/v1"
                  autoComplete="off"
                  onChange={event => onChange({ baseUrl: event.target.value })}
                />
              </Field>

              <Field label="API 协议" hint="内核按此协议发起请求；自建网关与绝大多数厂商用 openai-completions">
                <Select value={draft.protocol} onValueChange={value => onChange({ protocol: value })}>
                  <SelectTrigger className="cursor-pointer">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_PROTOCOLS.map(protocol => (
                      <SelectItem key={protocol} value={protocol} className="cursor-pointer">
                        {protocol}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label className="text-sm">模型目录</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={fetching}
                    className="shrink-0 cursor-pointer"
                    onClick={onFetch}
                  >
                    {fetching
                      ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                    {fetching ? '获取中…' : '获取可用模型'}
                  </Button>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  圆点是「当前使用」：对话模型各有其一，图片 / 视频模型也在这里标明用途——
                  客户有多少个图片、视频模型，就往这份目录里加多少行。显示名称留空就用模型 id。
                </p>
                <div className="flex flex-col gap-2">
                  {catalog.length === 0
                    ? <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">还没有模型，点「添加模型」手填，或「获取可用模型」勾选。</p>
                    : catalog.map(model => (
                      <ModelRow
                        key={model}
                        model={model}
                        label={draft.modelLabels[model] ?? ''}
                        kind={modelKind(draft, model)}
                        current={isCurrentModel(model, modelKind(draft, model))}
                        onSelect={() => onSelectModel(model, modelKind(draft, model))}
                        onRename={value => onRenameModel(model, value)}
                        onChangeLabel={value => onChangeModelLabel(model, value)}
                        onChangeKind={value => onChangeModelKind(model, value)}
                        onRemove={() => onRemoveModel(model)}
                      />
                    ))}
                </div>
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="cursor-pointer"
                    onClick={onAddModel}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    添加模型
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {error !== '' && (
          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        {notice !== '' && (
          <p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs leading-5 text-emerald-600">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {notice}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
          {dirty && (
            <Button variant="outline" disabled={saving} className="cursor-pointer" onClick={onCancel}>
              取消
            </Button>
          )}
          <Button onClick={onSave} loading={saving} className="cursor-pointer">
            <Save className="mr-1.5 h-4 w-4" />
            保存
          </Button>
        </div>
      </div>
    </div>
  )
}

export default ProviderEditor
