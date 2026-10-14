import type { SocialAccount } from '@web/api/accounts/account.types'
import { PlatType } from '@web/app/config/platConfig'
import { PubType } from '@web/app/config/publishConfig'
import { getPlatformInfoSync } from '@web/store/platformMetadata'
import { parseTopicString } from '@web/utils/common'

/**
 * 创建假账号以复用 PubParmasTextarea 组件
 * 固定用抖音（影响上传限制配置）；产品只做国内平台，不引用国外平台类型。
 */
export function createFakeAccount(): SocialAccount {
  const fakeId = `material-fake-${Date.now()}`
  return {
    id: fakeId,
    type: PlatType.Douyin,
    uid: fakeId,
    avatar: '',
    nickname: '素材账号',
    status: 1,
    fansCount: 0,
    readCount: 0,
    likeCount: 0,
    collectCount: 0,
    forwardCount: 0,
    commentCount: 0,
    workCount: 0,
    income: 0,
    rank: 1,
    groupId: '',
    loginTime: new Date().toISOString(),
    createTime: new Date().toISOString(),
    updateTime: new Date().toISOString(),
    lastStatsTime: new Date().toISOString(),
  }
}

function normalizeTopicText(topic: string) {
  return topic.replace(/^#+/, '').trim()
}

function getTopicKey(topic: string) {
  return normalizeTopicText(topic).toLowerCase()
}

export function appendMaterialTopicsToDescription(description: string, topics?: string[]) {
  if (!topics?.length)
    return description

  const { topics: descriptionTopics } = parseTopicString(description)
  const existingTopicKeys = new Set(descriptionTopics.map(getTopicKey))
  const appendedTopicKeys = new Set<string>()
  const topicText = topics
    .flatMap((topic) => {
      const topicLabel = normalizeTopicText(topic)
      const topicKey = getTopicKey(topicLabel)
      if (!topicLabel || existingTopicKeys.has(topicKey) || appendedTopicKeys.has(topicKey))
        return []

      appendedTopicKeys.add(topicKey)
      return [`#${topicLabel}`]
    })
    .join(' ')

  if (!topicText)
    return description.trim()

  return `${description}\n${topicText}`.trim()
}

export function getMaterialUploadPlatType(selectedPlatforms: PlatType[]) {
  const mediaPlatform = selectedPlatforms.find((platType) => {
    const pubTypes = getPlatformInfoSync(platType)?.pubTypes
    return pubTypes?.has(PubType.ImageText) && pubTypes.has(PubType.VIDEO)
  }) ?? selectedPlatforms.find((platType) => {
    const pubTypes = getPlatformInfoSync(platType)?.pubTypes
    return pubTypes?.has(PubType.ImageText) || pubTypes?.has(PubType.VIDEO)
  })

  return mediaPlatform ?? selectedPlatforms[0] ?? PlatType.Douyin
}
