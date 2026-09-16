/**
 * ProfileTab - 个人资料设置 Tab
 */

'use client'

import { Camera } from 'lucide-react'
import { useRef, useState } from 'react'
import { useShallow } from 'zustand/shallow'
import { updateUserInfoApi } from '@web/api/auth/auth.api'
import { uploadToOss } from '@web/api/materials/material.api'
import { useTransClient } from '@web/app/i18n/client'
import { Button } from '@web/components/ui/button'
import { useUserStore } from '@web/store/user'
import { cn } from '@web/utils/className'
import { toast } from '@web/utils/ui/toast'
import { UserAvatar } from '@web/components/common/UserAvatar'
import { AvatarCropModal } from './components/AvatarCropModal'

interface ProfileTabProps {
  onClose: () => void
}

export function ProfileTab(_props: ProfileTabProps) {
  const { t } = useTransClient('settings')
  const { t: tCommon } = useTransClient('common')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { userInfo, getUserInfo } = useUserStore(
    useShallow(state => ({
      userInfo: state.userInfo,
      getUserInfo: state.getUserInfo,
    })),
  )

  const [isEditingName, setIsEditingName] = useState(false)
  const [editName, setEditName] = useState(userInfo?.name || '')
  const [isSaving, setIsSaving] = useState(false)
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const [cropModalOpen, setCropModalOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const handleAvatarClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file)
      return

    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.avatarTypeError'))
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error(t('profile.avatarSizeError'))
      return
    }

    setSelectedFile(file)
    setCropModalOpen(true)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleCropComplete = async (blob: Blob) => {
    setIsUploadingAvatar(true)
    try {
      const file = new File([blob], `avatar_${Date.now()}.png`, { type: 'image/png' })
      const ossPath = await uploadToOss(file)

      const response = await updateUserInfoApi({
        name: userInfo?.name || '',
        avatar: ossPath,
      })

      if (response?.code === 0 && response.data) {
        await getUserInfo()
        toast.success(t('profile.avatarUpdateSuccess'))
        setCropModalOpen(false)
        setSelectedFile(null)
      }
      else {
        toast.error(response?.message || t('profile.avatarUpdateFailed'))
      }
    }
    catch (error) {
      console.error('头像上传失败:', error)
      toast.error(t('profile.avatarUpdateFailed'))
    }
    finally {
      setIsUploadingAvatar(false)
    }
  }

  const handleCropModalClose = () => {
    setCropModalOpen(false)
    setSelectedFile(null)
  }

  const handleSaveName = async () => {
    if (!editName.trim()) {
      toast.error(t('profile.nameRequired'))
      return
    }

    if (editName.length < 2 || editName.length > 20) {
      toast.error(t('profile.nameLengthError'))
      return
    }

    setIsSaving(true)
    try {
      const response = await updateUserInfoApi({
        name: editName.trim(),
        avatar: userInfo?.avatar,
      })

      if (response?.code === 0 && response.data) {
        await getUserInfo()
        toast.success(t('profile.nameUpdateSuccess'))
        setIsEditingName(false)
      }
      else {
        toast.error(response?.message || t('profile.nameUpdateFailed'))
      }
    }
    catch (error) {
      toast.error(t('profile.nameUpdateFailed'))
    }
    finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      {/* 用户信息卡片 */}
      <div className="flex items-center gap-4">
        <div className="group relative shrink-0 cursor-pointer" onClick={handleAvatarClick}>
          <UserAvatar
            name={userInfo?.name}
            avatar={userInfo?.avatar}
            className="h-16 w-16"
          />
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center rounded-full bg-black/50 transition-opacity',
              isUploadingAvatar ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            )}
          >
            {isUploadingAvatar ? (
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <Camera size={20} className="text-white" />
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
        </div>

        <div className="min-w-0 flex-1">
          {isEditingName ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter')
                    handleSaveName()
                  if (e.key === 'Escape') {
                    setIsEditingName(false)
                    setEditName(userInfo?.name || '')
                  }
                }}
              />
              <Button size="sm" onClick={handleSaveName} disabled={isSaving} className="h-8">
                {isSaving ? t('profile.saving') : t('profile.save')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsEditingName(false)
                  setEditName(userInfo?.name || '')
                }}
                className="h-8"
              >
                {t('profile.cancel')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              <div
                className="cursor-pointer text-lg font-semibold text-foreground transition-colors hover:text-primary"
                onClick={() => setIsEditingName(true)}
              >
                {userInfo?.name || tCommon('unknownUser')}
              </div>
            </div>
          )}
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {userInfo?.mail || (userInfo?.phone ? userInfo.phone.replace(/^(.{3}).*(.{4})$/, '$1****$2') : '-')}
          </p>
        </div>
      </div>

      {/* 头像裁剪弹窗 */}
      <AvatarCropModal
        open={cropModalOpen}
        onClose={handleCropModalClose}
        imageFile={selectedFile}
        onCropComplete={handleCropComplete}
        isUploading={isUploadingAvatar}
      />
    </div>
  )
}
