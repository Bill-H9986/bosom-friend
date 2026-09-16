/**
 * 系统设置页
 * 通用设置（含个人资料）/ 自定义大模型
 */
'use client'

import { useState } from 'react'
import { cn } from '@web/utils/className'
import { GeneralTab } from '../app/layout/SettingsModal/tabs'
import { ProfileTab } from '../app/layout/SettingsModal/tabs'
import { CustomLlmTab } from '../app/layout/SettingsModal/tabs/CustomLlmTab'
import { OtaTelemetryTab } from '../app/layout/SettingsModal/tabs/OtaTelemetryTab'
import { PageShell } from '../app/layout/PageShell'

type TabKey = 'general' | 'llm' | 'ota'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '通用设置' },
  { key: 'llm', label: '自定义大模型' },
  { key: 'ota', label: '系统与更新' },
]

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('general')

  return (
    <PageShell tabs={TABS} activeTab={tab} onTabChange={key => setTab(key as TabKey)}>
      {tab === 'general' && (
        <div className="flex flex-col gap-8">
          <section className="space-y-4">
            <div className="border-b border-border pb-2.5">
              <h3 className="section-title">个人资料</h3>
            </div>
            <ProfileTab onClose={() => undefined} />
          </section>
          <section className="space-y-4">
            <div className="border-b border-border pb-2.5">
              <h3 className="section-title">通用设置</h3>
            </div>
            <GeneralTab />
          </section>
        </div>
      )}
      {tab === 'llm' && <CustomLlmTab />}
      {tab === 'ota' && <OtaTelemetryTab />}
    </PageShell>
  )
}
