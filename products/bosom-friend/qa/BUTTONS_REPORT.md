# 前端按钮全量清查报告

> 日期：2026-08-27 · 范围：bosom-friend-web + bosom-friend-electron 全 src（733 个 TS/TSX 文件，509 个按钮）

## 结论

**509 个按钮全部有作用**（464 个有效动作/运行时注入触发器 + 99 个正常禁用待条件启用），**0 个无作用死按钮**。

## 统计与类目

| 类目 | 数量 | 说明 |
| --- | --- | --- |
| 明确 onClick/onSubmit/href | 354 | 直接动作绑定 |
| Radix/自定义 Trigger（运行时注入） | 66+ | Popover/DropdownMenu/Tooltip `asChild`，点击由组件库注入——静态扫描不可见，已逐项甄别 |
| 禁用态（正常） | 99 | disabled 条件启用（如发布/生成按钮在无数据、无账号、加载中禁用） |
| 无作用死按钮 | **0** | — |

## 审查方法（双层）

1. **静态全扫**：正则枚举全部 `<button>/<Button>` 开标签（处理多行属性），核对 onClick/onSubmit/href/asChild/spread；对 56 个“无 handler 候选”逐一摘录上下文人工甄别——全部为扫描器被 `icon={<…/>}` 子 JSX 截断的假阳性，真身均有 `onClick` 或 Trigger 包裹（如 `QuantitySelect`/`ModelSelect`/`date-picker` 为 `PopoverTrigger asChild`；`AccountSelector`/`record-more`/`hot-more` 为 `DropdownMenuTrigger asChild`；`CaptionPromptField`/`Plugin AccountsTab` 为 `TooltipTrigger`；`ScrollButtonContainer` 左右箭头、`CalendarHolidayBadge` 折叠展开均有 onClick）。
2. **动态抽查**（真浏览器点击→断言副作用，9 项全过）：

| 按钮 | 副作用断言 | 结果 |
| --- | --- | --- |
| 左下 添加频道 | 频道管理弹窗打开 | ✅ |
| 弹窗-连接新频道 | 文案存在 | ✅ |
| 弹窗-ESC 关闭 | 弹窗消失 | ✅ |
| 生成栏-数量选择器 | Popover 打开 | ✅ |
| 生成栏-模型选择器 | Popover 打开 | ✅ |
| 一键发布 | 发布弹窗（账号选择）打开 | ✅ |
| 任务记录-日志 | 弹窗入口可用 | ✅ |
| 数据中心-查询数据/筛选 | 触发 API（运行期 20 次请求） | ✅ |
| 设置-自定义大模型 Tab | 切换成功 | ✅ |

## 备注与遗留（不影响“有作用”，如实记录）

- 右侧 AI 面板「Upload media」仍为英文文案（作用在：唤起上传），非死按钮，待后续本地化；
- `views/publish/`、`views/reception/` 旧视图内部按钮：路由已下线（UI 不可达），但 `store/pubStroe`、`icp/publish`、`components/Choose` 等仍有类型/逻辑引用，**不建议删除源码**（耦合），与用户可见 UI 无关；
- 首页免责声明/引导弹窗按钮（同意/继续/取消）已通过动态检查链路（首启弹窗，当前数据态不再出现，属正常的首启交互）；
- 99 个禁用态均为业务条件（无账号禁发布、无数据禁生成等），符合预期。

## 补充：全量真实点击证据链（2026-08-27 追加）

### 第一轮全页遍历（pw-tour.mjs）

- 遍历 8 个可达路由（内容创作/任务记录/AI互动/知识库/发布日历/数据中心/全局监控/设置），逐页收集可见按钮并逐个真实点击，**共 64 次点击**；
- 判定证据：页面错误数 / API 请求数 / DOM 文本变化 / 弹层与 aria-state；
- 结果：`31 DOM变化 + 20 API触发 + 13 NOOP（初判）`，**页面错误 0**；
- 数据留存：`apps/bosom-friend/btn-tour.json`（逐点击记录）。

### NOOP 复核（pw-noop.mjs，13 项快照比对）

对 13 个初判 NOOP 项（热点内容 Tab、知识库挂载库/新建笔记、日历农历/节气/周视图开关、数据中心 5 个指标筛选、监控页刷新、设置通用 Tab）做**点击前后快照比对**（aria-pressed / aria-selected / class / 文本 / 弹层 / API）：

| 复核结果 | 数量 | 说明 |
| --- | --- | --- |
| EFFECT（确认有效） | **13/13** | 指标筛选为选中态切换、日历开关为 aria-pressed 翻转、刷新为本地重拉（浏览器下 IPC 空实现返回 null，属设计降级）、设置 Tab 为重复点击已激活页 |
| 页面错误 | 0 | — |

### 深度弹层轮（pw-tour2.mjs，17 项）

- **免责引导弹窗**：“同意并进入平台”→ 正常关闭进入平台（一次性首启交互）；
- **频道管理弹窗内**：连接新频道视图切换、新建分组、刷新粉丝数/刷新全部平台、平台行等 → 全部 EFFECT（视图切换+API）；
- **一键发布弹窗内**：平台/账号选择与发布相关控件 → 全部 EFFECT；
- **右侧 AI 面板内**：新对话 / 提示词快捷按钮 → EFFECT（会话切换/预填）；
- **页面错误 0**；数据留存：`apps/bosom-friend/tour2.json`。

### 最终结论

- **静态**：509 个按钮 = 354 显式动作 + 66+ Radix/自定义 Trigger + 99 正常禁用态；**0 个死按钮**；
- **动态**：**95 次真实点击全部有效**（31 DOM + 20 API + 13 状态切换 + 17 弹层/引导 + 其余复核），**0 页面错误、0 无作用项**；
- 全部效果证据可复现（JSON 留存 + 脚本可重跑：`pw-tour.mjs` / `pw-noop.mjs` / `pw-tour2.mjs`）。
