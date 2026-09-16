import dynamic from '@web/next-shims/dynamic'

const SharedChatPage = dynamic(() => import('../app/[lng]/chat/page'), {
  loading: null,
})

export default SharedChatPage
