/**
 * AccountsTopNav 组件
 *
 * 功能描述: 账号模块顶部导航栏
 * - 左侧: "新建作品"按钮 + 添加账号
 * - 右侧: 空间+频道融合选择器(支持按空间分组显示频道,可折叠)
 */

'use client'

import type { SocialAccount } from '@web/api/accounts/account.types'
import { Bot, SquarePen, UserPlus } from 'lucide-react'
import { useRouter } from '@web/next-shims/navigation'
import { memo, useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { apiUpdateAccountGroupSortRank } from '@web/api/accounts/account.api'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { useAccountStore } from '@web/store/account'
import { toast } from '@web/utils/ui/toast'
import AccountSelector from './components/AccountSelector'

export interface IAccountsTopNavProps {
  onNewWork?: () => void
  onAddAccount?: () => void
}

const AccountsTopNav = memo<IAccountsTopNavProps>(({ onNewWork, onAddAccount }) => {
  const { t } = useTransClient('account')
  const router = useRouter()
  const [accountSearchText, setAccountSearchText] = useState('')
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(new Set())
  const [sortLoading, setSortLoading] = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null)

  const {
    accountList,
    accountActive,
    setAccountActive,
    accountGroupList,
    getAccountGroup,
    activeSpaceId,
    setActiveSpaceId,
  } = useAccountStore(
    useShallow(state => ({
      accountList: state.accountList,
      accountActive: state.accountActive,
      setAccountActive: state.setAccountActive,
      accountGroupList: state.accountGroupList,
      getAccountGroup: state.getAccountGroup,
      activeSpaceId: state.activeSpaceId,
      setActiveSpaceId: state.setActiveSpaceId,
    })),
  )

  // 根据搜索文本筛选账户（不过滤离线账号）
  const filteredAccounts = useMemo(
    () =>
      accountList.filter(
        account =>
          account.nickname?.toLowerCase().includes(accountSearchText.toLowerCase())
          || account.uid?.toLowerCase().includes(accountSearchText.toLowerCase()),
      ),
    [accountList, accountSearchText],
  )

  // 处理账户选择
  const handleAccountSelect = useCallback(
    (account: SocialAccount | undefined) => {
      setAccountActive(account)
      setAccountSearchText('') // 清空搜索
    },
    [setAccountActive],
  )

  // 处理空间选择
  const handleSpaceSelect = useCallback(
    (spaceId: string | undefined) => {
      setActiveSpaceId(spaceId)
      setAccountActive(undefined) // 选择空间时清除账号选择
      setAccountSearchText('') // 清空搜索
    },
    [setActiveSpaceId, setAccountActive],
  )

  // 处理空间排序
  const handleGroupSort = useCallback(
    async (groupId: string, direction: 'up' | 'down') => {
      setSortLoading(groupId)
      try {
        const sortedGroups = [...accountGroupList].sort((a, b) => (a.rank || 0) - (b.rank || 0))
        const currentIndex = sortedGroups.findIndex(g => g.id === groupId)

        if (currentIndex === -1) {
          setSortLoading(null)
          return
        }

        const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
        if (newIndex < 0 || newIndex >= sortedGroups.length) {
          setSortLoading(null)
          return
        }

        // 交换位置
        ;[sortedGroups[currentIndex], sortedGroups[newIndex]] = [
          sortedGroups[newIndex],
          sortedGroups[currentIndex],
        ]

        // 更新rank
        const updateList = sortedGroups.map((group, index) => ({
          id: group.id,
          rank: index,
        }))

        const res = await apiUpdateAccountGroupSortRank({ list: updateList })
        if (res?.code === 0) {
          await getAccountGroup()
          toast.success(t('messages.sortSuccess'))
        }
        else {
          toast.error(res?.message || t('messages.sortFailed'))
        }
      }
      catch (error) {
        toast.error(t('messages.sortFailed'))
      }
      finally {
        setSortLoading(null)
      }
    },
    [accountGroupList, getAccountGroup, t],
  )

  // 切换空间折叠状态
  const toggleSpaceCollapse = useCallback((spaceId: string) => {
    setCollapsedSpaces((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(spaceId)) {
        newSet.delete(spaceId)
      }
      else {
        newSet.add(spaceId)
      }
      return newSet
    })
  }, [])

  // 显示空间分组的条件
  const showSpaceGroups = accountGroupList.length > 1

  // 获取排序后的空间列表
  const sortedGroups = useMemo(() => {
    return [...accountGroupList].sort((a, b) => (a.rank || 0) - (b.rank || 0))
  }, [accountGroupList])


  return (
    <>
      <div className="flex items-center gap-2">
        {/* 左侧: 操作按钮区域 */}
        <div className="flex items-center gap-1 md:gap-2">
          {/* 添加频道按钮（仅保留频道管理入口） */}
          <Button
            data-testid="accounts-add-account-btn"
            variant="outline"
            onClick={onAddAccount}
            className="h-8 gap-2 px-3 cursor-pointer"
          >
            <UserPlus className="h-4 w-4" />
            <span>{t('addAccount')}</span>
          </Button>
        </div>

        {/* 右侧: 频道选择器(按空间分组) */}
        <AccountSelector
          accountActive={accountActive}
          accountList={accountList}
          accountGroupList={accountGroupList}
          filteredAccounts={filteredAccounts}
          collapsedSpaces={collapsedSpaces}
          showSpaceGroups={showSpaceGroups}
          sortedGroups={sortedGroups}
          sortLoading={sortLoading}
          deleteLoading={deleteLoading}
          onAccountSelect={handleAccountSelect}
          onToggleSpaceCollapse={toggleSpaceCollapse}
          onGroupSort={handleGroupSort}
          searchText={accountSearchText}
          onSearchChange={setAccountSearchText}
          onAddAccount={onAddAccount}
          activeSpaceId={activeSpaceId}
          onSpaceSelect={handleSpaceSelect}
        />
      </div>
    </>
  )
})

AccountsTopNav.displayName = 'AccountsTopNav'

export default AccountsTopNav
