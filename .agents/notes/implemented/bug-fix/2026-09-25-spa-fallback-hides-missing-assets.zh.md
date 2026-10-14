# Agent Note: 缺失的静态资源如实回 404，不再假装是 index.html

Status: implemented

[English](2026-09-25-spa-fallback-hides-missing-assets.md) | 中文

## Problem

Bosom Friend 的静态服务（`products/bosom-friend/server/src/http.ts` 的 `serveSpa`）对每个未命中文件的路径都回 `dist/index.html` 与 200。于是请求带哈希分块的浏览器拿到的是标着 `text/html` 的 HTML，它要的是 JavaScript：浏览器以 `SyntaxError` 拒绝，而入口分块的懒加载路由——它们的 import 不会被 Vite 的模块预加载 polyfill 拒绝——永远挂起。

重建前端让这条路径变得可达：Vite 按内容给分块名加哈希，只产出当前这一套，因此持有上一版 `index.html` 的浏览器会去请求本次构建已删除的分块。在远程手机上这表现为路由错误边界里的 `未知错误`——边界报告的是 `String(event.error ?? '未知错误')`，而加载失败不带 `error`。

同一个处理器也从未真正提供过站点图标。它的分支拿请求 pathname 与 `/favicon.ico` 比较，但处理器注册在 `/bosom-friend` 前缀上，收到的是未剥离前缀的 `/bosom-friend/favicon.ico`，因此该分支从未执行。

## Decision

路径带扩展名且未命中文件的请求一律回 `404` 与 `text/plain`。只有不带扩展名的路径——即 hash 路由深链——仍回退 `index.html`，路由不受影响。路径遍历防护依旧最先执行。

`index.html` 的响应现在带一个由文件大小与修改时间推出的弱 `ETag`。既有的 `cache-control: no-cache` 只表示"可缓存但须重新校验"，而重新校验需要验证器：没有验证器时浏览器会直接用缓存副本，客户端就是这样被钉在已被替换的入口文档上的。

站点图标分支改为先剥掉挂载前缀再比较，并在 `dist/favicon.ico` 与 `dist/assets/favicon.ico` 两处查找（Vite 把 `public/` 原样投到 dist，被跟踪的图标落在 `assets/` 下）。入口文档声明的是 `/bosom-friend/favicon.ico`。

路由错误边界在 `window` 错误不带 `Error` 对象时，补上失败资源的 `src`/`href` 与标签名，让日后的加载失败报出地址而不是 `未知错误`。

## Alternatives considered

**保留回退，让客户端自己刷新。** 回退会销毁证据：任何请求都返回 200 与应用外壳，监控、探针或评审者都无法区分"服务了资源"与"资源缺失"。而且错误的内容类型比 404 明确更糟——它产生一个无法恢复的挂起 import，而不是一个失败的 import。

**对缺失资源回 `204 No Content`。** 对脚本回无正文的 204 会产生与本次修复要消除的同一个 `SyntaxError`，同时把读者需要的状态码藏起来。`404` 是唯一陈述事实的答复。

**不加 ETag，改为对当前 `index.html` 回 `no-store`。** `no-store` 同样能消除陈旧入口风险，但它会在每次导航时重新下载整份文档，而 hash 路由应用几乎一直在导航。

**在入口文档里声明绝对路径 `/favicon.ico` 来提供图标。** 该路径落在 `/bosom-friend` 前缀之外，产品处理器根本收不到它，会由宿主服务应答；图标应当位于应用自己的 base 之下。

## Consequences

持有已被替换的 `index.html` 的客户端现在会可见且可诊断地失败，而不是把界面冻住；缺失的资源会被如实报告为缺失。已部署的应用仍需重载一次才能取到新的入口文档；ETag 让这次重新校验变得可靠，而不是取决于客户端何时淘汰缓存。

对不存在的、带扩展名的深链请求现在回 404 而不是外壳。本应用没有任何带扩展名的路由。

`products/bosom-friend/server/test/functional/serve-spa-fallback.spec.ts` 在临时 dist 上驱动一个真实 HTTP 服务：缺失的分块、样式与图片必须回 404 且响应体不是 HTML；存在的分块仍须按其 JavaScript 内容类型提供；不带扩展名的深链与根路径仍须回外壳；编码后的遍历路径仍须被拒绝。遵循该文件自身的契约，遍历用例走原始 socket，因为 `fetch` 会在请求离开客户端之前就归一化 `..`。
