import { fallbackLng, languages } from '@web/app/i18n/settings'
import { getMetadata } from '@web/utils/metadata'
import { HotContentDetailContent } from '../../components/HotContentDetailContent'
import { HotContentNavigation } from '../../components/HotContentNavigation'

export async function generateMetadata({ params }: { params: { lng: string; sourceKey: string } }) {
  let { lng } = params
  if (!languages.includes(lng))
    lng = fallbackLng

  return getMetadata(
    {
      title: '热门内容详情',
      description: '查看指定平台实时热点榜单的完整详情。',
    },
    lng,
    '/hot-content',
  )
}

export default function HotContentSourcePage({ params }: { params: { sourceKey: string } }) {
  // Next 对含 % 的路径参数不解码，这里还原一次（如 tophub%3Axxx -> tophub:xxx）
  let sourceKey = params.sourceKey
  try {
    sourceKey = decodeURIComponent(params.sourceKey)
  }
  catch {
    sourceKey = params.sourceKey
  }

  return (
    <div className="min-h-full bg-muted/40">
      <HotContentNavigation />
      <HotContentDetailContent sourceKey={sourceKey} />
    </div>
  )
}
