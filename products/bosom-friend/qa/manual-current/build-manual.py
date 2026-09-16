#!/usr/bin/env python3
"""
生成 Bosom Friend 图文使用手册的独立 HTML。

复用线上旧版手册的样式与脚本，仅替换品牌文案、章节正文和截图。
截图以 data URL 内嵌，不依赖外部图片文件。
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

ROOT = Path(r"C:\Users\Jay\Desktop\Bosom friend APP")
SOURCE_HTML = Path(r"C:\Users\Jay\Desktop\ZhiYin-Ai smart system\docs\用户使用手册-图文版.html")
OUTPUT_HTML = Path(r"C:\Users\Jay\Desktop\ZhiYin-Ai smart system\docs\用户使用手册-图文版.html")
SHOT_DIR = ROOT / "products" / "bosom-friend" / "qa" / "manual-current"
LOGO = ROOT / "products" / "bosom-friend" / "project" / "bosom-friend-electron" / "public" / "assets" / "bosom-friend-logo.svg"


def data_uri(path: Path, mime: str = "image/png") -> str:
    data = path.read_bytes()
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


IMG = {
    "home": data_uri(SHOT_DIR / "01-home.png"),
    "draft": data_uri(SHOT_DIR / "02-draft-box.png"),
    "publish": data_uri(SHOT_DIR / "13-publish-dialog.png"),
    "channel": data_uri(SHOT_DIR / "15-channel-modal.png"),
    "monitor": data_uri(SHOT_DIR / "07-monitor.png"),
    "accounts": data_uri(SHOT_DIR / "08-accounts.png"),
    "rule": data_uri(SHOT_DIR / "16-rule-modal.png"),
    "data": data_uri(SHOT_DIR / "06-data-statistics.png"),
    "calendar": data_uri(SHOT_DIR / "05-calendar.png"),
    "ai": data_uri(SHOT_DIR / "03-ai-interaction.png"),
    "comment": data_uri(SHOT_DIR / "14-comment-search.png"),
    "tasks": data_uri(SHOT_DIR / "04-tasks-history.png"),
    "task_detail": data_uri(ROOT / "products" / "bosom-friend" / "qa" / "acceptance" / "final-task-chat.png"),
    "knowledge": data_uri(SHOT_DIR / "09-knowledge.png"),
    "chat": data_uri(ROOT / "products" / "bosom-friend" / "qa" / "field" / "04-byok-real.png"),
    "settings": data_uri(SHOT_DIR / "10-settings.png"),
    "settings_llm": data_uri(SHOT_DIR / "11-settings-llm.png"),
    "settings_system": data_uri(SHOT_DIR / "12-settings-system.png"),
}


def shot(key: str, alt: str) -> str:
    return f'<p><img loading="lazy" src="{IMG[key]}" alt="{alt}"></p>\n'


SOURCES = """<div id="bar"></div>
<nav class="top"><a class="brand" href="#"><img class="blogo" src="{logo}" alt="">Bosom Friend · 使用手册</a><span class="ver"><span>v0.13.5+</span><span>2026-09-01</span></span></nav>
<header class="hero"><div class="eyebrow">BOSOM FRIEND · OFFICIAL USER GUIDE</div><h1>Bosom Friend · AI 内容营销系统</h1><p class="sub">一句话创作 · 多平台发布 · 7×24 智能接待 —— 全流程图文指南</p><div class="chips"><span>本机网页版 / Windows 桌面端</span><span>适用版本 v0.13.5+</span><span>更新于 2026-09-01</span></div></header>
<div class="layout"><nav class="side" id="side"><div class="tt">目 录</div>
<a href="#1-快速上手启动与主界面"><span class="n">01</span>1. 快速上手：启动与主界面</a>
<a href="#2-内容创作草稿箱与素材库"><span class="n">02</span>2. 内容创作（草稿箱与素材库）</a>
<a href="#3-一键发布到多个平台"><span class="n">03</span>3. 一键发布到多个平台</a>
<a href="#4-绑定平台账号频道"><span class="n">04</span>4. 绑定平台账号（频道）</a>
<a href="#5-全局监控与-724-自动接待"><span class="n">05</span>5. 全局监控与 7×24 自动接待</a>
<a href="#6-ai-互动热点内容与评论搜索"><span class="n">06</span>6. AI 互动：热点内容与评论搜索</a>
<a href="#7-任务记录ai-任务管理"><span class="n">07</span>7. 任务记录：AI 任务管理</a>
<a href="#8-知识库"><span class="n">08</span>8. 知识库</a>
<a href="#9-右侧-ai-助手"><span class="n">09</span>9. 右侧 AI 助手</a>
<a href="#10-设置中心"><span class="n">10</span>10. 设置中心</a>
<a href="#11-常见问题-faq"><span class="n">11</span>11. 常见问题 FAQ</a>
</nav><main><blockquote class="reveal"><p>适用版本：v0.13.5 及以上（本机网页版 / Windows 桌面端）。</p><p>配图说明：每张配图下方的表格按「从左到右、从上到下」的顺序说明各功能区域的位置与用途。</p></blockquote>

<section class="card reveal" id="1-快速上手启动与主界面"><div class="kicker"><i></i><span>CH.01</span></div><h2>1. 快速上手：启动与主界面</h2><h3>1.1 启动 APP</h3><p>在浏览器打开本机地址或双击桌面快捷方式后，应用会自动启动本地服务并进入主界面。首次冷启动需要初始化本机数据，通常会比后续启动稍慢；服务就绪前页面会提示「本地服务启动中，数据将在就绪后自动加载」。</p><h3>1.2 主界面布局</h3>__SHOT_HOME__<div class="tbl"><table><tr><th>编号</th><th>区域</th><th>说明</th></tr><tr><td>①</td><td>左侧导航栏</td><td>内容创作、AI互动、任务记录、发布日历、数据中心、全局监控、知识库</td></tr><tr><td>②</td><td>开始创作</td><td>一键进入内容创作页面</td></tr><tr><td>③</td><td>添加频道</td><td>绑定小红书 / 抖音账号并打开频道管理</td></tr><tr><td>④</td><td>右侧 AI 助手</td><td>常驻面板，随时向 AI 提问（详见第 9 节）</td></tr><tr><td>⑤</td><td>Bosom Friend 客户端菜单</td><td>底部用户入口：联系我们 / 消息通知 / 设置</td></tr></table></div><p>首页主标题为「Bosom Friend AI 内容创作营销系统」，面向零基础用户，核心链路是 AI 创作 → 草稿 → 多平台发布 → 数据复盘 → 自动接待。</p></section>

<section class="card reveal" id="2-内容创作草稿箱与素材库"><div class="kicker"><i></i><span>CH.02</span></div><h2>2. 内容创作（草稿箱与素材库）</h2><p>点击左侧「内容创作」进入。页面顶部两个标签：<strong>创作 / 素材库</strong>。</p>__SHOT_DRAFT__<div class="tbl"><table><tr><th>编号</th><th>区域</th><th>说明</th></tr><tr><td>①</td><td>创作 / 素材库</td><td>切换创作工作台与素材管理</td></tr><tr><td>②</td><td>素材上传区</td><td>最多上传 1 段视频（≤180 秒）、1 个音频（≤180 秒）、9 张图片；提示词中输入 <code>@</code> 可引用素材</td></tr><tr><td>③</td><td>生成模式与参数</td><td>图文 / 视频模式、目标平台、模型、分辨率、比例、时长、数量、文案要求</td></tr><tr><td>④</td><td>一键发布</td><td>直接从当前内容发起发布流程</td></tr><tr><td>⑤</td><td>内容列表</td><td>全部 / 草稿 / 视频 / 图片，支持批量移动、批量删除、查看生成记录</td></tr></table></div><h3>2.1 AI 一句话生成草稿（核心流程）</h3><ol><li>在提示词输入框描述需求，例如「写一条无人机培训招生文案，突出 CAAC 证书价值」；</li><li>需要素材时先上传图片 / 视频 / 音频，并在提示词中用 <code>@</code> 引用；</li><li>选择生成模式（图文或视频）、目标平台、模型与尺寸 / 比例 / 时长 / 数量；</li><li>点击「生成草稿」，等待任务完成；</li><li>结果出现在下方列表，点击卡片可预览、编辑、发布或继续生成。</li></ol><h3>2.2 素材库</h3><p>AI 生成的图片、视频与手动物料会自动归档到「素材库」，支持按类型筛选、批量移动、批量删除与拖拽发布。</p></section>

<section class="card reveal" id="3-一键发布到多个平台"><div class="kicker"><i></i><span>CH.03</span></div><h2>3. 一键发布到多个平台</h2><p>在内容创作页右上角点击「一键发布」：</p>__SHOT_PUBLISH__<ol><li>弹窗内选择要发布的频道与账号；</li><li>尚未绑定账号时，点击「添加频道」先去绑定（见第 4 节）；</li><li>填写正文、标题、话题，并上传图片或视频；</li><li>检查各账号的平台参数与校验提示；</li><li>点击「下一步」进入发布确认，发布后可在「发布日历 / 数据中心」跟踪进度与数据。</li></ol><blockquote><p>说明：平台发送必须使用账号的真实登录态；没有登录或平台未返回作品链接时，系统会如实提示失败，不会标记为成功。</p></blockquote></section>

<section class="card reveal" id="4-绑定平台账号频道"><div class="kicker"><i></i><span>CH.04</span></div><h2>4. 绑定平台账号（频道）</h2><p>在左下角点击「添加频道」，或进入频道管理后点击「连接新频道」：</p>__SHOT_CHANNEL__<ul><li>当前「连接新频道」列表开放<strong>小红书</strong> 与 <strong>抖音</strong>；</li><li>点击平台卡片后，按页面提示用手机扫码或浏览器完成授权；</li><li>绑定成功后，账号会自动出现在「默认空间 / 我的频道」中；</li><li>已绑定账号自动纳入全局监控、数据采集与评论 / 私信读取；</li><li>可通过「新建分组」按业务划分账号，每个分组可独立展示与筛选。</li></ul><blockquote><p>页面内同时提供平台清单与其他平台的能力入口；实际能否授权、发布与采集以平台能力清单和当前登录态为准。</p></blockquote></section>

<section class="card reveal" id="5-全局监控与-724-自动接待"><div class="kicker"><i></i><span>CH.05</span></div><h2>5. 全局监控与 7×24 自动接待</h2><p>左侧导航点击「全局监控」：</p>__SHOT_MONITOR__<div class="tbl"><table><tr><th>编号</th><th>区域</th><th>说明</th></tr><tr><td>①</td><td>核心统计卡</td><td>绑定账号、在线账号、扫描评论、待前端确认</td></tr><tr><td>②</td><td>引擎参数</td><td>轮询间隔、每账号每轮上限、去重窗口、失败重试冷却</td></tr><tr><td>③</td><td>7×24 全自动接待</td><td>开启后由前端智能体自动读取并发送待办；关闭时只采集登记</td></tr><tr><td>④</td><td>平台统一监控总览</td><td>各平台账号数、评论接待 / 私信接待状态</td></tr><tr><td>⑤</td><td>账号级接待状态</td><td>已接入、平台风控、未登录、待接入等真实状态</td></tr></table></div><h3>5.1 接待引擎边界</h3><p>当前评论与私信读取覆盖<strong>抖音、小红书</strong>：</p><ul><li>引擎只做真实平台只读采集，命中规则的评论 / 私信会登记为「待前端确认」；</li><li>全自动模式由应用内的前端智能体触发发送；</li><li>关闭全自动模式时，需要你在「账号管理 → 评论接待 / 私信接待」中手动确认；</li><li>其他平台会明确显示「待接入 / 待官方插件」，不会伪造采集或发送结果。</li></ul><h3>5.2 账号管理与接待规则</h3><p>顶部选择或搜索账号后，进入「接待规则」标签：</p>__SHOT_ACCOUNTS____SHOT_RULE__<div class="tbl"><table><tr><th>字段</th><th>说明</th></tr><tr><td>规则名称</td><td>自定义名称，便于识别</td></tr><tr><td>触发关键词</td><td>输入后回车添加；命中任一关键词或全部命中</td></tr><tr><td>排除词</td><td>命中任意排除词的访客消息不触发此规则</td></tr><tr><td>适用账号 / 平台</td><td>可限定为单个账号或全部平台</td></tr><tr><td>回复方式</td><td>AI 智能生成（使用已配置大模型）或固定模板</td></tr><tr><td>客服人设</td><td>描述客服身份、语气与回复偏好</td></tr><tr><td>优先级 / 启用</td><td>数字越小越优先，可随时开关</td></tr><tr><td>失败重试冷却</td><td>失败后重新进入待办前需要等待的分钟数</td></tr></table></div><p>可先点「推荐模板」一键套用<strong>报价咨询 / 合作洽谈 / 售后客服 / 新品促销</strong>，也可用「测试接待」验证规则是否命中。</p><h3>5.3 数据中心</h3>__SHOT_DATA__<p>可切换全部平台或单个账号，选择日期范围后查看发布作品、播放 / 浏览、点赞、评论、分享、收藏等核心统计，以及增长趋势、平台贡献与平台效率。</p><h3>5.4 发布日历</h3>__SHOT_CALENDAR__<p>支持周视图 / 月视图、公历节日与节气显示；点击日期或作品可查看详情，桌面端可拖拽调整发布时间。</p></section>

<section class="card reveal" id="6-ai-互动热点内容与评论搜索"><div class="kicker"><i></i><span>CH.06</span></div><h2>6. AI 互动：热点内容与评论搜索</h2><p>左侧导航点击「AI互动」，上方包含<strong>热点内容 / 评论搜索</strong>两个标签。</p><h3>6.1 热点内容</h3>__SHOT_AI__<ul><li>聚合<strong>微博、抖音、小红书、知乎、B站</strong>等平台榜单；</li><li>每条内容可打开原文、查看热度与详情；</li><li>结合右侧 AI 助手，可让 AI 总结热点并给出选题建议。</li></ul><h3>6.2 评论搜索</h3>__SHOT_COMMENT__<ul><li>按关键词搜索全网笔记，输入品牌词、产品名或评论高频词；</li><li>筛选内容形式（图文笔记 / 视频笔记）、作者类型（素人 / 腰部达人 / 头部达人）、笔记分类（美食、旅行、美妆等）、时间范围（7 天 / 15 天 / 30 天 / 自定义）；</li><li>支持综合排序、互动量、点赞、收藏、评论、分享、最新发布；</li><li>结果可查看原文、打开详情、加载更多，并可按当前条件导出 Excel。</li></ul></section>

<section class="card reveal" id="7-任务记录ai-任务管理"><div class="kicker"><i></i><span>CH.07</span></div><h2>7. 任务记录：AI 任务管理</h2><p>左侧导航点击「任务记录」：</p>__SHOT_TASKS__<ul><li><strong>全部任务</strong>：列出 AI 对话、图文 / 视频生成与发布任务；</li><li>支持按标题搜索、收藏筛选与多种状态过滤；</li><li>点击任务卡片进入详情。</li></ul>__SHOT_TASK_DETAIL__<p>任务详情页可以看到 AI 的完整执行过程、工具调用、最终产出与发布动作卡，并支持<strong>收藏 / 分享 / 评分</strong>。执行中的任务会实时流式输出；离开后可在任务记录中重新进入查看。</p></section>

<section class="card reveal" id="8-知识库"><div class="kicker"><i></i><span>CH.08</span></div><h2>8. 知识库</h2><p>左侧导航点击「知识库」（仅桌面端启用）：</p>__SHOT_KNOWLEDGE__<ul><li>内置知识库随应用保存，包含平台发布指南、创作方法论、接待话术等；</li><li>左侧目录树与全库搜索；</li><li>中间支持 Markdown 编辑 / 预览，输入停止后自动保存；</li><li>笔记支持 <code>[[双链]]</code> 反向链接，形成网状知识结构；</li><li>右上角可新建笔记、挂载外部库，内置文档不可删除。</li></ul><blockquote><p>网页版未挂载 Electron IPC 时，知识库页面会提示「仅在桌面端可用」；桌面端打开后即可正常编辑。</p></blockquote></section>

<section class="card reveal" id="9-右侧-ai-助手"><div class="kicker"><i></i><span>CH.09</span></div><h2>9. 右侧 AI 助手</h2><p>每个页面右侧都有常驻<strong>AI 助手面板</strong>：</p>__SHOT_CHAT__<ul><li>直接输入需求：内容创作、热点选题、互动回复、发布建议都可以问；</li><li>三个快捷指令：帮我写一条抖音爆款文案、为一款新品生成小红书种草笔记、帮我总结今天的热点并给出选题；</li><li>点「新对话」开始全新会话；应用重启后临时会话会清理，长期数据保存在「任务记录」中；</li><li>未配置自己的大模型 API 时，面板使用内置模板兜底并提示配置入口。</li></ul></section>

<section class="card reveal" id="10-设置中心"><div class="kicker"><i></i><span>CH.10</span></div><h2>10. 设置中心</h2><p>点击底部「Bosom Friend 客户端」→「设置」进入，共三个分区：</p>__SHOT_SETTINGS__<div class="tbl"><table><tr><th>分区</th><th>功能</th></tr><tr><td>通用设置</td><td>个人资料（昵称、头像）、外观主题（浅色 / 深色 / 跟随系统）、界面语言</td></tr><tr><td>自定义大模型</td><td>配置自己的 OpenAI 兼容 API Key、模型与图片 / 视频通道</td></tr><tr><td>系统与更新</td><td>当前版本、数据安全、产品信息、检查更新与匿名遥测（桌面端高级选项）</td></tr></table></div><h3>10.1 自定义大模型（重要）</h3>__SHOT_SETTINGS_LLM__<p>系统不内置共享大模型 Key，完整 AI 能力需使用你自己的钥匙：</p><ol><li>点击「去 Agnes AI 国内站领取钥匙」，在 <code>https://platform.agnes-ai.cn/</code> 注册并创建 API Key（按量计费）；</li><li>填写 API 接口地址、你的 API Key、你的模型名称；</li><li>不确定模型名时可点击「自动获取可用模型」；</li><li>图片 / 视频模型为选填：同厂商可复用全局 Key，其他厂商可分别填写接口、Key 与模型名；</li><li>点击「保存并使用你的钥匙」立即生效；「清除」后可恢复内置模板模式。</li></ol><blockquote><p>🔒 安全说明：密钥保存在本机用户目录，不会随安装包分发；未配置时 AI 使用内置模板，不会伪造真实模型结果。</p></blockquote><h3>10.2 系统与更新</h3>__SHOT_SETTINGS_SYSTEM__<ul><li>当前版本：<code>v0.13.5</code>；</li><li>数据安全：服务仅绑定本机，数据保存在 <code>~/.bosom-friend/</code>，不主动上传云平台，启动时自动备份；</li><li>桌面端高级区：可配置更新服务器地址、立即检查更新、下载 / 安装新版本、匿名遥测开关；</li><li>浏览器网页版通常随产品交付自动更新，如需手动重新部署可参考部署文档。</li></ul></section>

<section class="card reveal" id="11-常见问题-faq"><div class="kicker"><i></i><span>CH.11</span></div><h2>11. 常见问题 FAQ</h2><p><strong>Q1：AI 助手说没有配置大模型，怎么办？</strong><br>到「设置 → 自定义大模型」领取并填写你自己的 API Key 与模型名。未配置时系统使用内置模板，不会调用真实模型。</p><p><strong>Q2：当前支持绑定哪些平台？</strong><br>频道连接页当前开放小红书、抖音；数据中心提供更多平台筛选项，但实际授权、发布、采集与接待请以平台能力清单和登录态为准。</p><p><strong>Q3：为什么评论 / 私信没有自动发出？</strong><br>安全设计是「只读采集 + 前端显式发送」。引擎只登记待办；你要么打开全自动接待，要么在评论 / 私信接待页手动确认发送。</p><p><strong>Q4：绑定的账号安全吗？会不会被封？</strong><br>应用使用真实平台登录态，带轮询间隔、去重窗口、失败冷却与风控状态提示。请按平台规则正常量级使用，避免短时间内高频操作。</p><p><strong>Q5：数据存在哪里？</strong><br>账号、作品、任务、素材与知识库都保存在本机产品目录（<code>~/.bosom-friend/</code>），不与开发系统 DSH 混用，并有启动备份。</p><p><strong>Q6：如何升级版本？</strong><br>桌面端在「系统与更新」中检查更新并安装；网页版随产品交付更新。遇到页面数据异常时，先重启本机服务或恢复备份。</p><p><strong>Q7：知识库为什么打不开？</strong><br>知识库依赖桌面端本地文件能力。网页版提示不可用时，请使用 Windows 桌面端打开。</p></section>

</main><button id="top" title="回到顶部">↑</button><div id="lb"><img id="lbi" alt=""></div><footer>Bosom Friend · AI 内容营销系统 —— 图文使用手册 · 全文完</footer>
"""


def main() -> None:
    original = SOURCE_HTML.read_text(encoding="utf-8")
    css_match = re.search(r"<style>(.*?)</style>", original, re.S)
    js_match = re.search(r"<script>(.*?)</script>", original, re.S)
    if not css_match or not js_match:
        raise RuntimeError("无法从旧手册提取样式或脚本")

    css = css_match.group(1)
    css = css.replace("#d70015", "#8b7cf6").replace("#ff6a3d", "#00b8d9")
    body = SOURCES
    body = body.replace("{logo}", data_uri(LOGO, "image/svg+xml"))
    replacements = {
        "__SHOT_HOME__": shot("home", "Bosom Friend 首页主界面"),
        "__SHOT_DRAFT__": shot("draft", "内容创作页面"),
        "__SHOT_PUBLISH__": shot("publish", "一键发布弹窗"),
        "__SHOT_CHANNEL__": shot("channel", "频道管理弹窗"),
        "__SHOT_MONITOR__": shot("monitor", "全局监控中心"),
        "__SHOT_ACCOUNTS__": shot("accounts", "账号管理与接待规则"),
        "__SHOT_RULE__": shot("rule", "新建接待规则弹窗"),
        "__SHOT_DATA__": shot("data", "数据中心"),
        "__SHOT_CALENDAR__": shot("calendar", "发布日历"),
        "__SHOT_AI__": shot("ai", "AI 互动热点内容"),
        "__SHOT_COMMENT__": shot("comment", "评论搜索"),
        "__SHOT_TASKS__": shot("tasks", "任务记录"),
        "__SHOT_TASK_DETAIL__": shot("task_detail", "任务详情"),
        "__SHOT_KNOWLEDGE__": shot("knowledge", "知识库"),
        "__SHOT_CHAT__": shot("chat", "右侧 AI 助手"),
        "__SHOT_SETTINGS__": shot("settings", "设置中心通用设置"),
        "__SHOT_SETTINGS_LLM__": shot("settings_llm", "自定义大模型"),
        "__SHOT_SETTINGS_SYSTEM__": shot("settings_system", "系统与更新"),
    }
    for key, value in replacements.items():
        body = body.replace(key, value)

    html = (
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        "<title>Bosom Friend · 图文使用手册</title>"
        f"<style>{css}</style></head><body>{body}"
        f"<script>{js_match.group(1)}</script>"
        '<script>var _b=document.querySelector(\'a.brand\');if(_b){_b.addEventListener(\'click\',function(e){e.preventDefault();window.scrollTo({top:0,behavior:\'smooth\'});});}</script>'
        "</body></html>"
    )
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"written {OUTPUT_HTML} ({OUTPUT_HTML.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
