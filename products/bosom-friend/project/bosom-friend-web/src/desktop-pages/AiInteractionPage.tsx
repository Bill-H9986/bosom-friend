import dynamic from '@web/next-shims/dynamic'

const AiInteractionClient = dynamic(
  () => import('../app/[lng]/ai-interaction/AiInteractionClient').then((m) => ({ default: m.AiInteractionClient })),
  { loading: null },
)

export default function AiInteractionPage() {
  return <AiInteractionClient />
}
