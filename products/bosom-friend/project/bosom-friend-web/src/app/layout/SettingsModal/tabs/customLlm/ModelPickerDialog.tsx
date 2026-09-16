/**
 * ModelPickerDialog - 设置 → 自定义大模型：「选择要添加的模型」弹窗。
 *
 * 点「获取可用模型」后弹出：把提供方返回的模型列成可勾选清单，支持搜索与全选，
 * 确认后写入该服务的模型目录。手工填过、但提供方本次没返回的模型不会被清掉——
 * 勾选只决定"这份清单里要哪些"，不替用户删除他自己写的。
 */
'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@web/components/ui/button'
import { Checkbox } from '@web/components/ui/checkbox'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@web/components/ui/dialog'
import { Input } from '@web/components/ui/input'
import { cn } from '@web/utils/className'

interface ModelPickerDialogProps {
  open: boolean
  /** 提供方本次返回的可用模型。 */
  models: string[]
  /** 该服务当前的模型目录：命中的默认勾选。 */
  current: string[]
  onOpenChange: (open: boolean) => void
  /** 确认：回传最终勾选的模型（调用方自行保留清单外的手工模型）。 */
  onConfirm: (picked: string[]) => void
}

export function ModelPickerDialog({
  open,
  models,
  current,
  onOpenChange,
  onConfirm,
}: ModelPickerDialogProps) {
  const [keyword, setKeyword] = useState('')
  const [checked, setChecked] = useState<string[]>([])

  // 每次打开都以当前目录重置勾选，避免上次残留影响这次选择。
  useEffect(() => {
    if (open)
      setChecked(current.filter(model => models.includes(model)))
  }, [open, current, models])

  useEffect(() => {
    if (!open)
      setKeyword('')
  }, [open])

  const visible = useMemo(() => {
    const key = keyword.trim().toLowerCase()
    return key === '' ? models : models.filter(model => model.toLowerCase().includes(key))
  }, [keyword, models])

  const allVisibleChecked = visible.length > 0 && visible.every(model => checked.includes(model))

  const toggle = (model: string, next: boolean) => {
    setChecked(list => (next ? [...new Set([...list, model])] : list.filter(item => item !== model)))
  }

  const toggleAll = () => {
    if (allVisibleChecked) {
      const visibleSet = new Set(visible)
      setChecked(list => list.filter(model => !visibleSet.has(model)))
      return
    }
    setChecked(list => [...new Set([...list, ...visible])])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>选择要添加的模型</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="text-xs leading-5 text-muted-foreground">
            以下是模型提供方的可用模型，勾选要添加的模型。
          </p>
          <div className="flex items-center gap-3">
            <Input
              value={keyword}
              placeholder="搜索模型"
              autoComplete="off"
              className="h-9"
              onChange={event => setKeyword(event.target.value)}
            />
            <button
              type="button"
              className="shrink-0 cursor-pointer text-xs text-brand-cyan hover:underline"
              onClick={toggleAll}
            >
              {allVisibleChecked ? '取消全选' : '全选'}
            </button>
          </div>
          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
            {visible.length === 0
              ? <p className="py-6 text-center text-xs text-muted-foreground">没有匹配的模型</p>
              : visible.map(model => (
                <label
                  key={model}
                  className={cn(
                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-muted',
                    checked.includes(model) && 'bg-muted/60',
                  )}
                >
                  <Checkbox
                    checked={checked.includes(model)}
                    onCheckedChange={value => toggle(model, value === true)}
                  />
                  <span className="min-w-0 flex-1 truncate">{model}</span>
                </label>
              ))}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" className="cursor-pointer" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            className="cursor-pointer"
            onClick={() => {
              onConfirm(checked)
              onOpenChange(false)
            }}
          >
            添加所选
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ModelPickerDialog
