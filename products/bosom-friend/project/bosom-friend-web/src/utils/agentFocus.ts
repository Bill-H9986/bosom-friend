/**
 * 助手焦点对象：页面把"用户此刻在看哪一条"登记进来，助手面板随每轮请求发给后端。
 *
 * 为什么需要一个独立的小模块而不是塞进某个 store：
 * 登记方（各个业务页面）与消费方（助手发送链路）之间没有共同的 React 祖先能传 props——
 * 助手面板挂在外壳上，草稿弹窗在页面深处。一个进程内的登记点比层层透传可靠。
 *
 * 路由与焦点必须对得上：登记的是"内容创作页里那条草稿"，换页之后就不该再送给模型，
 * 否则会出现"你在数据中心页问，助手答的却是内容创作页的草稿"这种更糟的错觉。
 */

/** 送给后端的焦点对象；字段与后端 `parseAgentFocus` 一一对应。 */
export interface AgentFocusPayload {
  /** 页面标识（中文名，直接进模型上下文）。 */
  page: string
  /** 对象种类，如 `草稿`/`账号`/`发布记录`；页面没有具体对象时为空串。 */
  objectKind: string
  /** 对象 id。 */
  objectId: string
  /** 对象标题。 */
  title: string
  /** 对象正文摘要（由登记方截断）。 */
  excerpt: string
}

/** 路由（hash 第一段）到页面名的映射；未登记的路由不带页面信息。 */
const PAGE_NAMES: Record<string, string> = {
  // 首屏（空 hash）就是对话主入口：让助手知道用户此刻站在对话上
  '': '对话',
  'draft-box': '内容创作',
  'long-video': '长视频创作',
  'digital-humans': '我的数字人',
  'tasks-history': '我的任务',
  calendar: '发布日历',
  'data-statistics': '数据中心',
  monitor: '全局监控',
  'ai-interaction': 'AI 互动',
  knowledge: '知识库',
  accounts: '账号管理',
  'agent-assets': '素材库',
  settings: '系统设置',
  chat: '对话',
  about: '关于本产品',
  // ADR-005 三区（对话 / 管家团队 / 看板）：不给新页面登记，"用户此刻在哪一页"
  // 这一条就断了——助手会拿上一页的焦点去答，比什么都不知道更糟。
  team: '管家团队',
  boards: '看板聚合',
}

/** 当前路由标识：取 hash 的第一段（`#/draft-box?...` → `draft-box`）。 */
function currentRoute(): string {
  if (typeof window === 'undefined')
    return ''
  const hash = window.location.hash.replace(/^#\/?/, '')
  return hash.split(/[/?]/)[0] ?? ''
}

let registered: { route: string, focus: AgentFocusPayload } | undefined

/** 登记当前页面正在看的对象；传 null 表示离开该对象。 */
export function setAgentFocus(focus: AgentFocusPayload | null): void {
  registered = focus === null ? undefined : { route: currentRoute(), focus }
}

/**
 * 读出这一轮该带的焦点。
 *
 * 页面上没有登记具体对象时，仍然如实告诉模型"用户在哪一页"——
 * 比什么都不说强，也比编一个对象安全。
 *
 * @returns 焦点载荷；连页面都认不出来时返回 undefined。
 */
export function readAgentFocus(): AgentFocusPayload | undefined {
  if (registered !== undefined && registered.route === currentRoute())
    return registered.focus
  const page = PAGE_NAMES[currentRoute()]
  if (page === undefined)
    return undefined
  return { page, objectKind: '', objectId: '', title: '', excerpt: '' }
}
