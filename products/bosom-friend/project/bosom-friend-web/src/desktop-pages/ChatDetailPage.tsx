import dynamic from '@web/next-shims/dynamic'

const ChatDetailPage = dynamic(() => import('../app/[lng]/chat/[taskId]/page'), {
  loading: null,
})

export default ChatDetailPage
