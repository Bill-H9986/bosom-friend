# 取证重做：受 `.gitignore` 影响的结论（2026-10-08）

> 触发原因：发现 `engine/.gitignore:4` 含 `social-auto-upload/`，ripgrep **遵守 gitignore 会整目录跳过**，
> 导致「以 engine 目录为 path 的 grep」静默返回 0 命中 —— 假阴性。
> 本轮只重做真正依赖该路径的结论，不扩大范围。

## 一、第一优先：engine 测试文件普查

### A + B. 物理上有多少测试文件（文件系统级扫描，绕开 ripgrep）

排除 `.venv/`（第三方依赖自带）后，**engine 下有 7 个测试文件**：

| 文件 | 字节 | 测什么 |
| --- | --- | --- |
| `social-auto-upload/tests/test_douyin_declaration.py` | 4,091 | **抖音自主声明**（7 个用例） |
| `social-auto-upload/tests/test_tencent_verification_dialog.py` | 1,638 | **视频号实时实名验证扫码** |
| `social-auto-upload/tests/test_sau_browser_cli.py` | 13,092 | sau CLI 浏览器行为 |
| `social-auto-upload/tests/test_xiaohongshu_uploader.py` | 9,645 | 小红书 uploader |
| `social-auto-upload/tests/test_bilibili_runtime.py` | 3,282 | B 站运行时 |
| `social-auto-upload/tests/test_sau_bilibili_cli.py` | 2,638 | B 站 CLI |
| `social-auto-upload/examples/test_alipay_upload.py` | 989 | 支付宝上传示例 |

**原结论「engine/ 下无 test_*.py，Python 引擎 0 测试」= 假阴性，作废。**

### C. 这些测试有没有被任何 runner 执行 → **没有**

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 仓库根 `pytest.ini` | `testpaths = python/sdk/tests` | **只收 DSH 官方 SDK 的测试**，不含 products/ |
| qa/ 的 549 个门禁 | grep `pytest` / `unittest` / `social-auto-upload/tests` → **0 命中** | 门禁完全不碰 Python 测试 |
| `social-auto-upload/pyproject.toml` | **无任何 test / pytest 配置** | 只有 build-system 与 dependencies |
| CI（.gitlab-ci.yml + 21 个 GH workflow） | python 任务只做 SDK 打包发布（`python-v*` tag） | 不跑 engine 测试 |

**净结论**：

> 引擎不是「没写测试」，而是「**写了 7 个测试，但没有任何 runner 收集它们**」。

这个区别决定了修复成本 —— 从「补测试」变成「接一个 runner」。

## 二、第二优先：平台风控/验证码结论重做（AST 函数级）

改用 Python `ast` 逐文件扫函数名、异常分支与文案（文件级读取，不受 gitignore 影响）：

| 平台 | 行数 | 函数 | except | 验证码/风控相关函数 | 文案命中 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| douyin | 1,784 | 55 | 63 | `_read_verify_code` `_submit_sms_verify_code` `_verify_douyin_login` `_wait_for_douyin_login` + qrcode×4 | 验证码×23 风控×1 频繁×1 重试×7 | **有** |
| **tencent** | 1,253 | 57 | 46 | **`wait_for_realtime_verification:532`** `wait_for_upload_complete:818` + qrcode×5 | 扫码×16 **实名×4** 重试×7 | **有**（原报告遗漏） |
| kuaishou | 891 | 30 | 21 | 仅 qrcode×5 | 扫码×7 重试×4 | 无验证码风控 |
| weibo | 804 | 24 | 28 | 仅 `_emit_qrcode_callback` | 扫码×20 重试×1 | 无 |
| hupu | 524 | 22 | 7 | 仅 qrcode | 扫码×9 | 无 |
| xiaohongshu | 1,094 | 43 | 32 | `_wait_for_xhs_publish_success` + qrcode×5 | 扫码×6 重试×1 | 无 |

**结论变化**：
- 快手 / 微博 / 虎扑 / 小红书「无验证码风控处理」→ **原结论保持**，但证据等级从「没搜到」升为「**函数级确认**」
- **视频号被原报告遗漏**：它有 `wait_for_realtime_verification`（管理员微信扫码实名验证）+ 一个专门的测试文件
- 抖音的验证码链路是完整的（读码 → 提交短信码 → 等登录）

## 三、`NotImplementedError` 全仓分布（本轮附带产出）

| uploader | NotImplementedError | 类 |
| --- | --- | --- |
| douyin | 0 | DouYinBaseUploader / DouYinVideo / **DouYinNote** |
| kuaishou | 0 | KSBaseUploader / KSVideo / **KSNote** |
| xiaohongshu | 0 | XiaoHongShuBaseUploader / XiaoHongShuVideo / **XiaoHongShuNote** |
| **tencent** | **3**（:1198 :1201 :1204） | TencentBaseUploader / TencentVideo / **TencentNote（骨架）** |
| 其余 7 个 | 0 | — |

**`TencentNote` 是全仓库唯一的骨架**。这解释了为什么只有视频号的图文对不上：
抖音/快手/小红书的 `*Note` 都是完整实现且都有 `upload-note`；只有视频号的 `TencentNote` 是骨架且没有 CLI 入口。

## 四、四级能力模型（本轮起正式采用）

```
L0  代码存在
L1  代码可调用（有入口、能被实例化）
L2  链路可执行（input → worker → CLI → 引擎 → 平台）
L3  真实运行验证（真实账号跑通）
```

| 能力 | L0 | L1 | L2 | L3 | 卡在哪 |
| --- | --- | --- | --- | --- | --- |
| 抖音 + 视频 | ✓ | ✓ | ✓ | **✓** | — |
| 抖音 + 图文 | ✓ | ✓ | ✓ | ✗ | 崩在 `--declaration` 参数契约 |
| 快手 + 图文 | ✓ | ✓ | ✓ | 未验证 | 同参数契约 + 无账号 |
| 小红书 + 图文 | ✓ | ✓ | ✓ | 未验证 | 同上 |
| **视频号 + 图文** | ✓（骨架） | **✗** | **✗** | ✗ | **卡在 L0** |
| 其余 5 平台 + 视频 | ✓ | ✓ | ✓ | 未验证 | 同参数契约 |

**以后不许再说「我们支持视频号图文」**——正确的说法是「**卡在 L0**」。

## 五、受影响的结论清单（重做 / 保留 / 待重做）

**已重做（本轮）**
1. ~~「engine 下无测试文件，Python 引擎 0 测试」~~ → 「**有 7 个测试文件，但无 runner 收集**」
2. ~~「快手/微博/虎扑/小红书无验证码风控处理」~~ → **保持**，证据升级为函数级；**新增**视频号有实名验证

**仍待重做（同源假阴性，本轮未覆盖）**
3. 子智能体报告中的「engine 根目录与 social-auto-upload 全量 .py 两轮 grep（sk- / api_key / secret / password）均 0 命中」
   —— 涉及 `social-auto-upload/` 的那一轮**可能假阴性**，需用文件级方式重扫
4. 同源的「engine/cookies 目录为空，来源与用途未查明」等依赖目录扫描的结论

**不受影响（独立证据，明确保留）**
- `0.0.0.0:31280` 监听实况（`Get-NetTCPConnection`）
- 3 条抖音图文失败记录（`state.json` / `publish-records.json` 直接读取）
- `worker.py` ↔ `sau_cli.py` 的参数不匹配（文件级逐行读取 + ast 提取）
- 197 条路由（正则计数）
- `api.ts` 规模（文件读取）
- `knowledge.json` 结构与体量（直接读取）
- `security.json` 的 `loopback=true` 硬编码（文件读取）
- 明文凭据（直接读文件）

**所以这不是「技术地图作废」，而是一次标准的变更影响分析：局部重测，其余保留。**

## 六、本轮额外学到的一条取证纪律

```
搜索结果 = 0
   ↓ 先确认搜索工具是否真的遍历了目标路径
   ↓ 检查 .gitignore / .rgignore / exclude / hidden / vendor 规则
   ↓ 必要时改用具体文件路径
   ↓ 必要时改用 AST / Select-String / 直接读取
```

本轮实证：同一模式 `TencentVideo`，`path=engine 目录` → 0 命中；`path=sau_cli.py 单文件` → 5 命中；
Select-String 单文件 → 5。**0 命中不等于不存在。**

*本轮仍为只读取证，未修改任何代码，未运行引擎或测试。*