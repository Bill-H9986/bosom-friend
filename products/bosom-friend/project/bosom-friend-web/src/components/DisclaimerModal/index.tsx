/**
 * DisclaimerModal - 首次启动免责协议弹窗
 *
 * 首次打开 APP 时展示免责声明，用户必须勾选“我已阅读并同意”后才能使用。
 * 确认后写入本地存储，后续启动不再弹出。
 */
'use client'

import { CheckCircle2, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@web/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/components/ui/dialog'
import { cn } from '@web/utils/className'
import http from '@web/utils/request'

const ACCEPTED_KEY = 'bosom-friend-disclaimer-accepted-v1'
// 会话内确认标记：即使本地存储不可用，同一次运行内也不再反复弹出
let sessionAccepted = false

const DISCLAIMER_SECTIONS = [
  {
    title: '一、平台性质',
    body: 'Bosom Friend AI 内容创作营销系统是一款免费的 AI 内容创作与多平台运营工具平台，仅为大家的内容创作、多平台发布与自动接待提供便利。本平台不向用户收取任何费用，亦不对用户的使用行为作出任何承诺或担保。',
  },
  {
    title: '二、责任承担',
    body: '用户在使用本平台（包括但不限于 AI 内容生成、平台发布、评论/私信自动接待、数据采集等功能）过程中产生的一切行为及其后果，包括但不限于内容合规性、账号风险、平台处罚、法律责任等，均由用户本人自行承担。本平台不承担任何直接或间接的法律责任。',
  },
  {
    title: '三、合规使用',
    body: '用户承诺遵守中华人民共和国的法律法规及各目标平台的社区规范，不得利用本平台制作、发布、传播任何违法违规、侵权、虚假或违背公序良俗的内容；不得从事刷量、导流、骚扰等违规行为。因用户违反上述约定导致的一切后果由用户自行承担。',
  },
  {
    title: '四、AI 内容提示',
    body: '本平台由 AI 大模型驱动生成内容，AI 生成结果仅供用户参考，用户应对最终发布的内容进行人工审核并承担全部责任。平台对 AI 生成内容的准确性、完整性、合规性不作任何保证。',
  },
  {
    title: '五、其他',
    body: '本平台保留在不另行通知的情况下修改、暂停或终止相关服务的权利。用户继续使用本平台即视为接受最新版本免责声明。',
  },
]

export function DisclaimerModal() {
  const [open, setOpen] = useState(false)
  const [checked, setChecked] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined')
      return
    const fromStorage = (() => {
      try {
        return window.localStorage.getItem(ACCEPTED_KEY) === 'true'
      }
      catch {
        return false
      }
    })()
    if (sessionAccepted || fromStorage) {
      setOpen(false)
      setReady(true)
      return
    }
    // 后端持久化确认（应用内浏览器等 localStorage 不稳定环境的兜底）
    let cancelled = false
    http.get<{ accepted?: boolean }>('v2/prefs/disclaimer', undefined, true)
      .then((result) => {
        if (cancelled)
          return
        const accepted = result?.data?.accepted === true
        if (accepted)
          sessionAccepted = true
        setOpen(!accepted)
      })
      .catch(() => setOpen(true))
      .finally(() => {
        if (!cancelled)
          setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const confirm = () => {
    if (!checked)
      return
    try {
      window.localStorage.setItem(ACCEPTED_KEY, 'true')
    }
    catch {
      // 本地存储不可用时也允许进入
    }
    sessionAccepted = true
    void http.put('v2/prefs/disclaimer', { accepted: true }, true).catch(() => {
      // 后端写入失败不阻塞进入；下次启动仍会以本地标记为准
    })
    setOpen(false)
  }

  const sections = useMemo(
    () => DISCLAIMER_SECTIONS.map((section, index) => (
      <section key={section.title}>
        <h4 className="mb-1 text-sm font-semibold text-foreground">{section.title}</h4>
        <p className="text-sm leading-6 text-muted-foreground">{section.body}</p>
        {index < DISCLAIMER_SECTIONS.length - 1 && <div className="my-3 h-px bg-border/70" />}
      </section>
    )),
    [],
  )

  if (!ready)
    return null

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-lg" hideCloseButton>
        <DialogHeader>
          <div className="mb-2 flex items-center gap-2">
            <ShieldAlert className="size-5 text-brand-cyan" />
            <DialogTitle>Bosom Friend平台免责声明</DialogTitle>
          </div>
          <DialogDescription>
            感谢使用Bosom Friend AI 内容创作营销系统。当前平台仍处于测试阶段，功能与生成效果持续优化中；AI 服务使用你自己的API钥匙（不涉及任何积分/计费）。在使用本平台前，请仔细阅读并确认以下免责声明。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-y-auto rounded-lg border border-border/70 bg-muted/30 p-4">
          {sections}
        </div>

        <button
          type="button"
          onClick={() => setChecked(prev => !prev)}
          className="flex cursor-pointer items-start gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-accent/50"
        >
          <span
            className={cn(
              'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border transition-all duration-200',
              checked
                ? 'border-transparent bg-gradient-back text-gradient-foreground shadow-sm'
                : 'border-border bg-background',
            )}
          >
            {checked && <CheckCircle2 className="size-4" />}
          </span>
          <span className="text-sm leading-5 text-muted-foreground">
            我已阅读并同意以上
            <span className="font-medium text-foreground">免责声明</span>
            ，自愿承担使用本平台产生的一切后果。
          </span>
        </button>

        <div className="flex justify-end">
          <Button
            type="button"
            disabled={!checked}
            className="cursor-pointer"
            onClick={confirm}
          >
            同意并进入平台
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default DisclaimerModal
