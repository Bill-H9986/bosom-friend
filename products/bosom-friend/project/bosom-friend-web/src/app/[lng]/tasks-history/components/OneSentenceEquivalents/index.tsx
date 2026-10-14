/**
 * 开关：产品负责人 2026-10-13 要求「前端还是用 0.2.62 那套」。
 *
 * 0.2.62 只留下**产物**（编译后的 dist），没有源码——「要 0.2.62 的界面」与「前端要保持可改」
 * 物理上只能选一个。这里的取舍是：**留下源码可改**（否则 DEF-250/236 这类前端缺陷永远修不了），
 * 但把这块**做成可关**：`false` 时组件渲染 null，**12 个页面同时回到 0.2.62 那种"没有这块"的样子**。
 * 要开回来只改这一个常量，不用碰任何页面。
 */
const SHOW_EQUIVALENTS = false

/** 各主要页面的「一句话等价物」：这里的事，对右侧 AI 助手说一句话就能办；纯展示，无执行入口。 */
const SAYINGS: Record<string, readonly string[]> = {
  'tasks-history': ['最近跑了哪些任务？', '草稿箱里有哪些图文草稿？', '把这条发到小红书（发布要你明确下令，助手不会自己发）'],
  'draft-box': ['草稿箱里有哪些图文草稿？', '把这条草稿改成更口语的开头', '把这条发到小红书（发布要你明确下令，助手不会自己发）'],
  'data-statistics': ['数据中心现在是什么情况？', '最近发出去的作品数据怎么样？', '哪条作品涨粉最快？'],
  'accounts': ['我绑了哪些账号？', '小红书账号还能发吗？', '同步一下抖音的作品数据'],
  'ai-interaction': ['最近和助手聊过什么？', '把上次那条草稿接着改', '这条对话里说的事办到哪了？'],
  'settings': ['大模型配置在哪？', '换模型要改哪一处？', '数据备份存在哪儿？'],
  'agent-assets': ['素材库里有哪些图片？', '这个素材用在哪条草稿里？', '把这条素材发到小红书（发布要你明确下令，助手不会自己发）'],
  'knowledge': ['知识库里有哪些笔记？', '搜一下「无人机」相关的笔记', '把这条沉淀进知识库'],
  'home': ['帮我做一条小红书的图文', '最近有什么热点可以蹭？', '把上次那条草稿改一改'],
  'team': ['管家团队里谁在办什么？', '这条任务现在走到哪一步了？', '这条任务交给发布管家去办'],
  'calendar': ['这个月排了哪些发布？', '把这条排到周五发', '下周有什么节日能蹭？'],
  'chat-detail': ['这条对话里的事办到哪一步了？', '接着上一次继续改', '把这次的结果存进草稿箱'],
}

export function OneSentenceEquivalents({ page }: { page: string }) {
  if (!SHOW_EQUIVALENTS) return null
  return (
    <section aria-label="一句话等价物" className="mx-auto mb-4 w-full max-w-6xl rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <h2 className="text-sm font-semibold text-foreground">这些事，说一句话就能办</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">对右侧「AI 助手」说下面任意一句，它自己去调工具办完；这里只把过程与结果摆给你看。发布类动作必须你明确下令。</p>
      <ul className="mt-1.5 flex flex-col gap-0.5">
        {(SAYINGS[page] ?? []).map(s => <li key={s} className="text-xs text-muted-foreground">「{s}」</li>)}
      </ul>
    </section>
  )
}
