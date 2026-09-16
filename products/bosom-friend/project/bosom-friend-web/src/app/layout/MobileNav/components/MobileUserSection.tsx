import type { MobileUserSectionProps } from '../types'
/**
 * MobileUserSection - 移动端用户头像/登录区域
 */
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { useUserStore } from '@web/store/user'
import { navigateToLogin } from '@web/utils/auth'
import { UserAvatar } from '@web/components/common/UserAvatar'

export function MobileUserSection({
  onClose,
  onOpenSettings,
}: MobileUserSectionProps) {
  const { t } = useTransClient('common')
  const token = useUserStore(state => state.token)
  const userInfo = useUserStore(state => state.userInfo)

  const handleLogin = () => {
    onClose()
    navigateToLogin()
  }

  if (token && userInfo) {
    const handleClick = () => {
      onClose()
      onOpenSettings()
    }

    return (
      <button
        onClick={handleClick}
        data-testid="mobile-user-btn"
        className="flex w-full items-center gap-3 px-4 py-3 rounded-lg text-muted-foreground hover:bg-muted transition-colors cursor-pointer"
      >
        <UserAvatar
          name={userInfo.name}
          avatar={userInfo.avatar}
          className="h-8 w-8"
        />

        <div className="flex min-w-0 flex-1 flex-col items-start">
          <span className="truncate text-sm font-medium text-foreground" data-testid="mobile-user-name">
            {userInfo.name || t('unknownUser')}
          </span>
        </div>
      </button>
    )
  }

  return (
    <Button onClick={handleLogin} className="w-full cursor-pointer" data-testid="mobile-login-btn">
      {t('login')}
    </Button>
  )
}
