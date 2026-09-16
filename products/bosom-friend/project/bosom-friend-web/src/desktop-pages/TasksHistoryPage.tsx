import dynamic from '@web/next-shims/dynamic'

const TasksHistoryPageContent = dynamic(
  () => import('../app/[lng]/tasks-history/TasksHistoryPageContent').then((m) => ({ default: m.TasksHistoryPageContent })),
  { loading: null },
)

export default function TasksHistoryPage() {
  return <TasksHistoryPageContent />
}
