import type { SocialAccount } from '@web/api/accounts/account.types'
import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons'
import { AccountStatus } from '@web/app/config/accountConfig'
import { useTransClient } from '@web/app/i18n/client'

function AccountStatusView({ account }: { account: SocialAccount }) {
  const { t } = useTransClient('account')
  // 平台明确判定登录失效时优先显示"需重新登录"：否则账号看着"在线"，
  // 用户只有翻发布记录才知道要重扫（发布失败只写记录错误行）。
  if (account.loginState === 'invalid') {
    return (
      <span
        className="flex items-center gap-1 text-xs text-warning"
        title={account.loginNote ?? t('offline')}
      >
        <WarningOutlined className="text-xs" />
        {t('reloginRequired')}
      </span>
    )
  }
  if (account.status === AccountStatus.USABLE) {
    return (
      <span className="flex items-center gap-1 text-xs text-success">
        <CheckCircleOutlined className="text-xs" />
        {t('online')}
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1 text-xs text-warning">
      <WarningOutlined className="text-xs" />
      {t('offline')}
    </span>
  )
}

export default AccountStatusView
