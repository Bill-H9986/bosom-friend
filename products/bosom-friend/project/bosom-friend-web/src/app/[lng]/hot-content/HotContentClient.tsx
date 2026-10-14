'use client'

import { HotContentHomeContent } from './components/HotContentHomeContent'
import { HotContentNavigation } from './components/HotContentNavigation'

export function HotContentClient() {
  return (
    <HotContentNavigation hideTabs>
      <HotContentHomeContent />
    </HotContentNavigation>
  )
}
