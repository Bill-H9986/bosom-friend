/**
 * 前端唯一的发布记录状态命名处。协议值仍是数字（服务端接口字段 `status`）。
 *
 * 取值必须与服务端 `PUBLISH_RECORD_STATUS`（products/bosom-friend/server/src/types.ts）
 * 逐项一致；服务端只下发 FAIL/UNPUBLISH/RELEASED/PUB_LOADING/QUEUED/PLATFORM_SCHEDULED/CANCELED。
 */
export enum PublishStatus {
  FAIL = -1, // 发布失败（服务端 FAILED）
  UNPUBLISH = 0, // 未发布（服务端 PENDING）
  RELEASED = 1, // 已发布（服务端 PUBLISHED）
  PUB_LOADING = 2, // 发布中（服务端 PUBLISHING）
  WAITING_FOR_UPDATE = 3, // 等待更新（服务端当前不下发）
  UPDATING = 4, // 更新中（服务端当前不下发）
  UPDATED_FAILED = 5, // 更新失败（服务端当前不下发）
  QUEUED = 6, // 队列中（服务端 QUEUED）
  PLATFORM_SCHEDULED = 7, // 平台已定时（服务端 SCHEDULED）
  WAITING_FOR_USER_ACTION = 8, // 等待用户操作（服务端当前不下发）
  CANCELED = 9, // 已取消（服务端 CANCELED）
}
