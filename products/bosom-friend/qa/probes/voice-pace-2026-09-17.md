# 音色实测：语速标定与 SSML 边界（2026-09-17）

> 用途：`server/src/digital-human.ts` 里的 `charsPerSecond` 与 `baseline` 是**实测值**，
> 这份记录是它们的来源与重测方法。探针：`qa/probes/probe-voice-pace.mjs`。

## 1. 音色清单（`MsEdgeTTS.getVoices()`）

接口返回 **322 条语音，其中中文 14 条**（`zh-CN` 8 条含 2 条方言、`zh-HK` 3 条、`zh-TW` 3 条）。
修复前产品只摆了 8 条（少了粤语 3 条与台湾普通话 3 条）。14 条全部实测合成成功。

## 2. 语速实测（样音 = 试听文本，去标点 32 字）

> 更正（2026-09-21）：本节原先写"去标点 38 字"是笔误。探针 `probe-voice-pace.mjs` 里数的是
> `VOICE_PREVIEW_TEXT` 去掉「，。」后的 **32 字**（`VOICE_PREVIEW_TEXT.length` 是 36）。
> 下表的秒数除出来的"字/秒"用的就是 32，与目录记录逐条吻合；
> 标定口径本身没问题，**音色目录的语速值不需要重测**（2026-09-21 复测 14 条，逐条一致）。

| 音色 | 秒数 | 字/秒 | 目录记录 |
| --- | --- | --- | --- |
| zh-CN-XiaoxiaoNeural | 7.97 | 4.02 | 4.1 |
| zh-CN-XiaoyiNeural | 7.73 | 4.14 | 4.1 |
| zh-CN-YunjianNeural | 7.61 | 4.20 | 4.1 |
| zh-CN-YunxiNeural | 7.73 | 4.14 | 4.1 |
| zh-CN-YunxiaNeural | 8.21 | 3.90 | 4.1 |
| zh-CN-YunyangNeural | 7.15 | 4.48 | 4.1 |
| zh-CN-liaoning-XiaobeiNeural | 9.46 | 3.38 | 3.9 |
| zh-CN-shaanxi-XiaoniNeural | 8.33 | 3.84 | 4.1 |
| zh-HK-HiuGaaiNeural | 10.75 | 2.98 | 3.4 |
| zh-HK-HiuMaanNeural | 8.02 | 3.99 | 4.1 |
| zh-HK-WanLungNeural | 7.70 | 4.16 | 4.1 |
| zh-TW-HsiaoChenNeural | 8.23 | 3.89 | 4.1 |
| zh-TW-HsiaoYuNeural | 9.70 | 3.30 | 3.8 |
| zh-TW-YunJheNeural | 7.03 | 4.55 | 4.1 |

结论：**同一条稿子，最慢的音色要比最快的多念 53% 的时间**（2.98 vs 4.55 字/秒）。
基准韵律按 `目标 4.1 ÷ 实测` 修正，吸收上限 ±15%（再快就发假）；三条慢音色
（曉佳 3.4、曉雨 3.8、晓北 3.9）如实记录真实语速，由写稿字数按它折算。

## 3. SSML 边界（负面结论，避免重复尝试）

| 试法 | 结果 |
| --- | --- |
| `<break time="1500ms"/>`（rawToStream） | 失败：`Stream closed before the synthesis completed (no turn.end received)` |
| `<mstts:express-as style="cheerful">` | 同上 |

Edge 朗读接口只吃 `speak` / `voice` / `prosody` 三种元素。所以**停顿与情绪只能靠韵律与写短的句子**，
不能靠 SSML。这条结论写在 `server/src/tts.ts` 的模块注释里。
