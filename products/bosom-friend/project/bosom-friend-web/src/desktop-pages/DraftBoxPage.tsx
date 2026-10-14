import dynamic from '@web/next-shims/dynamic'

const DraftBoxCore = dynamic(() => import('../app/[lng]/draft-box/DraftBoxCore'), {
  loading: null,
})

export default function DraftBoxPage() {
  return <DraftBoxCore />
}
