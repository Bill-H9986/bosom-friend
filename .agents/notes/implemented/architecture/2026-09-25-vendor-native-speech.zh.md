# Agent Note: 长视频里的口播交给厂商原生发声

Status: implemented

[English](2026-09-25-vendor-native-speech.md) | 中文

## Problem

产品原先自己合成口播：`msedge-tts` 逐句合成，`ffmpeg` 把句子按停顿拼起来，产出的音频要么作为数字人的参考音送给视频厂商，要么贴在非口播镜上当旁白。而厂商只在提示词明确要求时才开口——两半根本对不上。

2026-09-25 用一条 15 镜的一分钟成片实测：15 镜里有 14 镜的音轨是数字静音（均值 −63 到 −85 dB）。母时钟——也就是产品在任何出片调用之前就定下的逐镜时长——是按本机合成的时长算出来的，厂商随后按自己的节奏把每一镜重念一遍，于是镜头长度与烧进画面的字幕都偏离了计划。产品还为此背着一整套声音面——14 条 Edge 音色、5 种演绎风格、带钳制的韵律层、试听、声音克隆，以及一条写进内核设置的用户自建配音来源路由——用来生成一种厂商根本不建模的声音：Agnes 没有音色 id 这种东西。

## Decision

媒体能力缝保留三个操作——`generateImage`、`submitVideo`、`pollVideo`——不再承载语音。`@deepseek-ai/dsh-media-pi-ai` 的逐路由 `speech` 方言被删除；参考词汇新增 `MediaTalkingHead.videos` 与 `MediaReferenceVideo`：一个公网可读的 URL 或 data URI、可选的起始秒、可选的"是否必须有音轨"。归属、选择与方言规则未变，见[媒体能力缝](2026-09-23-media-capability-seam.zh.md)。

产品删除 `server/src/tts.ts`、`server/src/tts-provider.ts`、`msedge-tts` 依赖、音色目录 / 演绎风格 / 韵律 / 试听 / 克隆这几组路由，以及设置页的"配音来源"段。成片里那一声就是厂商按提示词自己出的那一声。

内容创作（内容创作）超过 12 秒的档位改走长视频工作流、由场景生成器出片，不再"同一句提示词连下 N 片再拼"。它传 `registerAsMaterial: false` 让生成记录继续是成片的唯一归属，跑完再把 `videoUrl` 拷回生成记录。草稿自己的正文只有在该草稿不是本机分镜模板产出时才作为 `scriptText` 交出去（判据是 `response.longVideo === undefined`）：一分钟档的 description 就是那份本机分镜模板、不是口播稿，交出去会被当成「模型自述混进正文」，因此那个档位让编排层按主题现写台词。跑成功后，成片真正念的那份稿件写回草稿正文，草稿正文因此就是片子里念的那段文本。

## Digital human and shot prompts

一个数字人 = 形象素材 + 念法 + 种子。

形象素材是一张照片，或一段视频：创建路由从视频里抽出首帧写进 `avatarUrl`，并裁出一段 2–12 秒的 720p H.264/AAC 参考片段写进 `sourceVideoUrl`。口播请求把首帧放进 `talkingHead.images`，把片段放进 `talkingHead.videos`。

念法是一个 id 加一句描述，取自 `DIGITAL_HUMAN_PERSONAS`（9 条）。这句描述写进**每一镜**的提示词，因为厂商逐镜独立生成、镜间不共享状态。旧数字人记录保留只读的 `voice` 与 `voiceStyle` 字段，`personaPrompt` 会把它们折成一条念法，不让这些用户失去声音。

长视频把台词逐字写进每一镜的提示词：口播镜拿到「请让画面里的人用自然的口语说出下面这句话…」再接台词；产品镜 / 场景镜 / 文字卡拿到「用画外音（旁白）说出这句话…」。母时钟从一次合成变成一份预算：`planShotSeconds` 逐镜返回 `clampSegmentSeconds(estimateSeconds(line))`，厂商被要求的就是这些秒数。稿子偏短时在花钱调厂商之前补写一版的对账回路保留，只是改成对着这份预算量。

## Alternatives considered

**把产品侧 TTS 留作能力缝的一个提供方。** 能力缝的提供方角色做的是归一厂商线上方言；把合成器塞进去等于留着那个产出静音镜的第二只时钟，而成片里开口的仍然是厂商。两个声音没有任何下游环节能对上。

**把念法保留成到厂商音色 id 的映射。** Agnes 没有音色 id，这个映射没有可指的目标；念法仍然只是一段提示词，只是它与请求之间多了一层间接。

**非口播镜继续贴本机合成的旁白。** 把本机音轨混到厂商片段上，恰好保留了实测发现的那件事：厂商自己的音轨还是静音，而混进去的音轨与画面节奏毫无关系。

**只用抽出来的首帧，丢掉参考视频。** 参考视频是唯一携带"这个人怎么动、怎么发声"的请求通道；只有首帧时，动作与声音都是模型想象，而不是用户素材的延续。

**把克隆与试听留成脱离长视频的独立功能。** 这两件事都只为挑一条声音。念法只是一段提示词，没有声音可挑，留着这个面就是在许诺厂商兑现不了的控制。

## Consequences

本机已经没有音频通路，成片里的口播就是厂商出的那一声。厂商无视那句要求时，某一镜仍然可能回来是静音的；烧进画面的字幕仍然带着台词。念法只是一段提示词，所以它约束声音，而不保证声音。参考视频必须是一个公网可读的 URL 或内联的 data URI，随包的保护按 32 MB 拦内联素材，低于厂商自己的 50 MB 上限。声音克隆与试听对用户不再存在。

## Verification

两个媒体包各自的套件都通过：`pnpm exec vitest run packages/media` 报 79 个用例全过，覆盖 `media.spec.ts`、`vendor.spec.ts`、`provider.spec.ts`。`pnpm exec tsc -p products/bosom-friend/server/tsconfig.json --noEmit` 退出码 0；`node products/bosom-friend/qa/verify-video-duration-wiring.mjs` 10 项断言全过，其中一项断言拼装档位分支走 `generateSegmentedVideo` 且带 `registerAsMaterial: false`、被删掉的 `generateComposedVideo` 路径没有回来。产品服务端的套件在写这份笔记时仍在改写中，所以这里记的是实测结果、而不是一条长期性质：2026-09-25 跑 `pnpm exec vitest run --root products/bosom-friend/server`，54 个文件里 423 个用例通过、33 个失败。失败的文件除 `test/functional/video-reference.spec.ts`（它的两个失败打的是真厂商）之外，都还在引用已被删掉的语音面：`test/audio-join.spec.ts`、`test/functional/digital-human.spec.ts`、`test/functional/long-video.spec.ts`、`test/functional/tts-provider.spec.ts`、`test/functional/voice-clone.spec.ts`、`test/functional/voice-media-route.spec.ts`、`test/media-trace.spec.ts`。这份套件因此不构成本次改动的证据。

真机端到端出片**未**验证：本地凭据背后的 Agnes 账号已无剩余额度，请求在预扣费阶段就以 403 失败。一次探针确认：带 `videos: [{ url: <data URI> }]` 的 `mode: reference` 请求在 `agnes-video-2.5` 上通过了参数校验（走到了计费检查），而 Agnes 对 flash 模型写明 `videos is not supported`。服务在真正出片时能否取到内联 data URI 里的参考视频，仍未验证。
