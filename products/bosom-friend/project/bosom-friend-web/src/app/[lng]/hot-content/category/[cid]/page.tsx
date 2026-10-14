import { fallbackLng, languages } from '@web/app/i18n/settings'
import { getMetadata } from '@web/utils/metadata'
import { HotContentCategoryContent } from '../../components/HotContentCategoryContent'
import { HotContentNavigation } from '../../components/HotContentNavigation'

export async function generateMetadata({ params }: { params: { lng: string; cid: string } }) {
  let { lng } = params
  if (!languages.includes(lng))
    lng = fallbackLng

  return getMetadata(
    {
      title: '热门内容分类',
      description: '按分类浏览各平台实时热点榜单。',
    },
    lng,
    '/hot-content',
  )
}

export default function HotContentCategoryPage({ params }: { params: { cid: string } }) {
  return (
    <div className="min-h-full bg-muted/40">
      <HotContentNavigation />
      <HotContentCategoryContent cid={params.cid} />
    </div>
  )
}
