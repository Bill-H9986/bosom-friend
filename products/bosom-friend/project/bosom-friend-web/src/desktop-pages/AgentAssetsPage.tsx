import dynamic from '@web/next-shims/dynamic'

const AgentAssetsPageCore = dynamic(
  () => import('../app/[lng]/agent-assets/agentAssetsPageCore').then((m) => ({ default: m.AgentAssetsPageCore })),
  { loading: null },
)

export default function AgentAssetsPage() {
  return <AgentAssetsPageCore />
}
