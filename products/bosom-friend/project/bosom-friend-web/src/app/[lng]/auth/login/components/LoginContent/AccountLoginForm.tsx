/**
 * AccountLoginForm - 本地账号登录/注册表单（用户名 + 密码）
 * 替代邮箱/手机验证码流程：单机产品使用本地账号体系（scrypt 哈希、服务端会话）。
 */

'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { registerApi, usernameLoginApi } from '@web/api/auth/auth.api'
import { Button } from '@web/components/ui/button'
import { Input } from '@web/components/ui/input'
import type { UserInfo } from '@web/store/user'
import { useUserStore } from '@web/store/user'
import { toast } from '@web/utils/ui/toast'

interface AccountLoginFormProps {
  /** 弹框模式：登录成功回调 */
  onLoginSuccess?: () => void
}

export function AccountLoginForm({ onLoginSuccess }: AccountLoginFormProps) {
  const { setToken, setUserInfo } = useUserStore()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    if (username.trim() === '' || password === '') {
      toast.error('请输入用户名和密码')
      return
    }
    if (mode === 'register') {
      if (password.length < 6) {
        toast.error('密码至少 6 位')
        return
      }
      if (password !== confirm) {
        toast.error('两次输入的密码不一致')
        return
      }
    }
    setLoading(true)
    try {
      const res = mode === 'login'
        ? await usernameLoginApi({ username: username.trim(), password })
        : await registerApi({ username: username.trim(), password, name: name.trim() || undefined })
      if (res?.code === 0 && res.data?.token) {
        setToken(res.data.token)
        if (res.data.userInfo)
          setUserInfo(res.data.userInfo as UserInfo)
        toast.success(mode === 'login' ? '登录成功' : '注册成功')
        onLoginSuccess?.()
      }
      else {
        toast.error(res?.message || '操作失败')
      }
    }
    finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
        <Button
          type="button"
          variant={mode === 'login' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setMode('login')}
        >
          登录
        </Button>
        <Button
          type="button"
          variant={mode === 'register' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setMode('register')}
        >
          注册
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <Input
          autoComplete="username"
          placeholder="用户名（3-32 位字母、数字或 _-）"
          value={username}
          onChange={e => setUsername(e.target.value)}
          disabled={loading}
        />
        <Input
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={mode === 'login' ? '密码' : '密码（至少 6 位）'}
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={loading}
        />
        {mode === 'register' && (
          <>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="确认密码"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              disabled={loading}
            />
            <Input
              placeholder="昵称（可选）"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={loading}
            />
          </>
        )}
      </div>

      <Button type="button" onClick={submit} disabled={loading} className="w-full">
        {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
        {mode === 'login' ? '登录' : '注册并登录'}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        账号与数据仅保存在本机，密码经加盐哈希后存储。
      </p>
    </div>
  )
}
