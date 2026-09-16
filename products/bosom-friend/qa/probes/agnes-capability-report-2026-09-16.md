# Agnes 厂商能力边界实测（P0 探针结论）

> 探针脚本：`qa/probes/agnes-probe.mjs`（真实调用，非文档推断）
> 实测时间：2026-09-16　　凭证：`.env` 的 `AGNES_API_KEY`（base `https://api.agnes-ai.cn/v1`）
> 原始响应与图像证据：`qa/evidence/agnes-probe-2026-09-16/`

## 结论速览

| # | 问题 | 实测结论 |
| --- | --- | --- |
| 1 | 这个 key 能用哪些模型？ | 白名单 9 个；**用户当前设置里的 `agnes-image-2.5-flash` 不在其中 → 每次都 403** |
| 2 | 图像端点能做图生图吗（关键帧链式的前提）？ | **不能**：`image` 字段被接受但**被静默忽略**；`images`/`reference_images`/`init_image` 直接 400 |
| 3 | 视频 `reference` 模式能锁住同一个人吗？ | **能**：2 张参考图 + 固定 seed → 成片与参考图是同一人（抽帧比对通过） |
| 4 | 真实 TTS 音频能驱动口播吗？ | **能**：内联 mp3（data URI）被接受，成片有独立 AAC 音轨、嘴型在动 |
| 5 | 生成速度 | 5 秒成片约 50 秒完成（建任务→completed），720x1280 / 24fps / h264 + AAC 32kHz |

## 一、模型可用性：产品设置里存着一个无权限的模型名（已定位为"图片生成失败"的真因）

`GET /v1/models` 返回 11 个模型；**这个 key 的白名单是以下 9 个**：

`agnes-2.0-flash`、`agnes-2.5-flash`、`agnes-2.5-pro`、`agnes-2.5-pro-alpha`、`agnes-2.5-pro-beta`、
`agnes-3.0-flash`、`agnes-image-2.1-flash`、`agnes-video-2.5`、`agnes-video-2.5-flash`

而用户数据根里的 `llm-user.json` 写的是：

```json
"imageModel": "agnes-image-2.5-flash",   // ← 不在白名单 → 403
"videoModel": "agnes-video-2.5-flash"    // ← 在
```

403 原文：

```json
{"error":{"message":"team not allowed to access model. This team can only access models=[...]. Tried to access agnes-image-2.5-flash",
 "type":"team_model_access_denied","param":"model","code":"403"}}
```

**影响**：图片/封面生成整条链路必然失败（用户看到的"AI 素材生成失败""封面抽不出来"即此），
与网络、配额无关。`agnes-image-2.1-flash` 实测 200 正常出图。

**产品侧真正的修法不是改一个常量**，而是：设置页保存模型前先 `GET /v1/models`（或用一次最小真实调用）
验证该 key 是否有权限，没权限就**当场说清楚**而不是等生成时抛 403。

## 二、图像端点：`image` 字段被接受，但参考图被静默忽略（P0 最关键否证）

| 请求 | 结果 |
| --- | --- |
| `{model, prompt, n, size}` | 200 出图 |
| `{..., image: <url>}` | 200 出图（换了一条队列：响应来自 `platform-outputs.agnes-ai.space`），**但内容与参考图无关** |
| `{..., images: [url]}` | 400 `images 不是文生图队列支持的字段` |
| `{..., reference_images: [url]}` | 400 同上 |
| `{..., init_image: url}` | 400 同上 |

**决定性验证一（产品一致性）**：参考图是白瓶印 `NOTHING` + 一排 7 个紫点 + 瓶底紫标签印 `4821`
（证据 `01-参考图.png`）；请求"保持该产品外观/颜色/标签文字/数字完全不变，放到浴室台面上"（带 `image`）
→ 输出是**另一支泵头玻璃瓶**，标签为乱码 `ALTLONE / MUSKIRY CADEE / Torsiinattin Sodi Pretrarg`
（证据 `02-图生图-未保留参考产品.png`）。

**决定性验证二（人物一致性）**：参考图是盘发 + 奶白毛衣 + 米色墙的正面主播，请求"保持长相/发型/服装/背景一致改侧面"
→ 输出是**另一个人**（直发、驼色针织、客厅环境）（证据 `03-图生图-未保留同一个人.png`）。

**结论：`agnes-image-*` 没有可用的图生图能力。**
所以 ClipFactory 那套"关键帧链式生成（下一帧以上一帧为参考）"**在本厂商图像模型上不成立**，
照抄会得到"每镜换产品、换脸"的结果。这个坑必须在设计阶段绕开，而不是写完代码再发现。

## 三、视频 `reference` 模式：多参考图确实锁人（P0 好消息）

请求（真实 TTS 音频内联 + 两张参考图 + 固定 seed）：

```json
{"model":"agnes-video-2.5-flash","seconds":"5","size":"720P","aspect_ratio":"9:16",
 "mode":"reference","images":["<A正面>","<B侧30度>"],
 "audios":["data:audio/mpeg;base64,..."],"seed":20260916}
```

实测结果：

- 任务 200 `queued` → 约 50 秒后 `completed`，产出 `720x1280 / 24fps / h264 + AAC 32kHz 立体声`，时长 5.18 秒；
- **抽帧比对：成片人物与两张参考图是同一人**（同样的鹅蛋脸、黑色披肩发、米白针织衫、米色墙），
  证据 `04-成片抽帧-1s.png` / `05-成片抽帧-3s.png` / `06-成片抽帧-5s.png`；
- **嘴型在动** → 真实 TTS 音频确实驱动了口播（音频 41904 字节，msedge-tts `zh-CN-XiaoxiaoNeural`）。

**这条结论决定了"多机位数字人"可做**：同一套参考图 + 固定 seed，跨镜能保持是同一个人。

### 反面证据（同样是实测，别忽略）

第三次探针往 `audios` 里塞了一个图片 URL，厂商返回
`{"code":"invalid_media","message":"input audio or video is invalid or unsupported"}` 并 `failed`——
**这反过来证明 `audios` 字段会被真正解析**，"参数被接受"与"参数被使用"必须分开验证。

## 四、对工作流设计的直接影响

| 原计划（照抄开源） | 实测后必须改成 |
| --- | --- |
| 图像侧关键帧链式（上一帧当参考） | **不可行**。一致性只能靠**视频侧多参考图 + 固定 seed** |
| 用图像生成多个机位（锁脸） | **不可行**（会换脸）。机位差异只能由**视频提示词**描述；参考图集一旦固定就不要再换 |
| 产品图当锚点保证包装文字正确 | 图像侧做不到；产品外观只能靠视频侧参考图，**画面里的产品文字仍可能出错** → 品牌文字走后期叠加 |
| 直接用开源方案的模型名 | 必须先用 `/v1/models` 校验权限（本 key 已有一次 403 实证） |

## 五、本报告的边界（如实）

- 只测了一个 key（白名单随套餐变化），所以产品**不能把模型名写死**；
- 未测 `agnes-video-2.5`（非 flash）与 `agnes-video-v2.0` 在参考模式下的画质差异；
- 未测"参考音频能否克隆音色"（本次只证明了它驱动口型）；这一条要用"给 A 音色参考 + 让 B 音色念内容"的对照实验才能定性；
- 未测多参考图数量上限（厂商文档口径为图 ≤5、音频 ≤3，本次只用了 2+1）。
