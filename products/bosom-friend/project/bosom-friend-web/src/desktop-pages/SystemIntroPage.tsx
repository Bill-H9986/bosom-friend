import dynamic from '@web/next-shims/dynamic'

const AiSocialPageContent = dynamic(
  () => import('../app/[lng]/ai-social/AiSocialPageContent').then((m) => ({ default: m.AiSocialPageContent })),
  { loading: null },
)

export default function SystemIntroPage() {
  return <AiSocialPageContent introMode />
}
