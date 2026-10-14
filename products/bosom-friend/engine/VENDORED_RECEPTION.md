# Vendored / evaluated: AI reception engine

## 结论：本轮没有引入新的可执行第三方代码

优先级排序后，本轮只做“复用已有成熟页面驱动 + 借用两个 MIT 项目的匹配粒度/页面流程思路”，
没有复制 AGPL 或无 LICENSE 仓库的代码进本产品。原因与证据如下。

## 上游调研与许可证（2026-09-01 核实）

| 上游 | 许可证 | 结论 |
| --- | --- | --- |
| `git-rumengai/MediaMate` | MIT（GitHub API 返回 `MIT`） | 思路可参考；其 Playwright 页面驱动与本产品现有 `commentPageDriver`、Python `interactions.py` 同构，继续复用本产品已实测的驱动，不重复引入整套项目 |
| `puyujian/xhssx` | MIT（GitHub API 返回 `MIT`） | 可作小红书专业版私信页驱动参考；当前账号缺少消费者端 `web_session`，先如实报错，不通过伪造结果绕过 |
| `joneqian/ChatGPT-On-CS` | AGPL-3.0 | **不引入**：本项目最终交付形态为 MIT 产品，直接复制会引入 AGPL 网络分发与源码义务 |
| `AIjiaKeFu/AI-Customer-Service` | AGPL-3.0（README 明确） | **不引入**：同上 |
| `Rockedw/douyin-web-api-sdk` | 未发现 LICENSE 文件 | **不引入**：只作为“抖音 Web 私信 protobuf/WebSocket 能力存在”的参照；没有许可证就不搬代码 |
| `social-auto-upload` | MIT（已在 `VENDORED.md` 记录） | 继续负责登录/发布，不把接待逻辑混入 |

## 本轮“搬/抄”了什么

1. **规则匹配只复用一处纯函数实现**
   - 新增 `server/src/reception-rules.ts`，把原本 `routes-content.ts` 与
     `reception-engine.ts` 两份几乎相同的 `matchReception` 合并为一份。
   - 匹配语义保持兼容：账号专属规则优先、平台级规则回退、优先级升序。
   - 为什么：两份实现会导致禁词/全半角/“全部命中”等优化只在一处生效，未来更容易出现
     “前端测试命中、后台采集漏匹配”的漂移 BUG。
2. **文本归一化使用平台通用做法**
   - `String.prototype.normalize('NFKC')` + `toLowerCase` + 合并空白。
   - 为什么：中文访客常混用全角问号、全角空格、大小写英文；这是成熟文本匹配的通用手段，
     不需要自研分词。
3. **真实平台发送继续复用本产品已有页面驱动**
   - 评论/私信仍由 `engine/interactions.py`、`platform-interactions.ts` 呼起真实浏览器页面。
   - 为什么：这些链路已经过 2026-08-31 真机验证（抖音评论回复成功、私信列表真实读取、
     平台拒绝原因如实透传），符合“能搬则搬、不重写核心流程”。
4. **没有自研平台协议**
   - 抖音私信 `abogus`/`msToken` 通道仅在参考清单中，未引入无 LICENSE 代码；
     若后续要接，必须先确认许可证，再决定 vendoring。
5. **全自动发送复用前端智能体执行链路**
   - 新增 `bosom-friend-web/src/utils/receptionAutoRunner.ts` 作为“前端智能体”入口：
     页面运行时读取待办、生成缺失建议、调用页面已有的 `interactionApi.reply` 真实平台任务，
     完成后由前端写回待办状态。
   - 逻辑与既有 `executeAgentPublishAction` 的跟随模式同构：后端只按前端请求处理，
     不由后端定时器直接发送；平台动作仍由 `engine/interactions.py` 的真实浏览器执行。

## 本地补丁 / 小改动

- 后端 `reception-engine.ts`：真正落盘 `receptionSeen`，按窗口去重；
  `intervalMinutes`、`maxPendingPerRound` 不再硬编码；每账号每轮有登记上限。
- `ReceptionPendingItem` 增加 `status/handledAt/error/sentText` 生命周期，
  前端发送成功/失败后回写，不再把所有待办永久堆在列表里。
- 规则支持 `matchMode: any/all`、`excludeKeywords`、`cooldownMinutes`；
  这些字段全部来自前端表单，后端只做校验与匹配，不新增隐藏魔法。

## 为什么没有整体引入 MediaMate / xhssx

两个项目都以真实网页自动化为主，与本产品现有 Patchright/页面驱动路线一致；
但整体引入会带来新的运行时依赖、窗口管理策略和账号会话差异，且本产品当前已有
真实链路可用。遵循“先复用已验证路径”的铁律，本轮不为了“看起来开源”而引入
未经本项目验收的外部项目；待平台页面或协议变化时，再按上游 commit 精准 vendor
对应选择器/流程，并记录补丁原因。
