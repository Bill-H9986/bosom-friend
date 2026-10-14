/**
 * 联系我们 / 工单反馈接口
 */
import http from '@web/utils/request'

export interface FeedbackPayload {
  title: string
  content: string
  contact?: string
}

/** 提交工单反馈：后端真实发送邮件到客服邮箱 */
export async function submitFeedback(payload: FeedbackPayload): Promise<{ sent: boolean }> {
  const res = await http.post<{ sent: boolean }>('contact/feedback', payload)
  return res?.data ?? { sent: false }
}
