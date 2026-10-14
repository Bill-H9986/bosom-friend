# 0.2.58 验收报告：内容创作 30 秒 / 1 分钟档位 + 四条缺陷闭环（2026-09-19）

版本：**0.2.58**（安装包 742.8 MB，SHA256 `08314CCCE07634FB19E56ED594DA31E9B973924BED4AE43ADC3F1DBF70E25662`）
数据根：`~/.bosom-friend/bosom-friend`（验收用测试数据已清理，用户数据 11 条内容 / 1 条生成记录原样保留）

## 结论

| 缺陷 | 状态 | 证据 |
| --- | --- | --- |
| DEF-107 长档位被 15 分钟媒体超时判死 | **Fixed** | 装机版真跑：30 秒档 7 片 → status=success / 30.14 秒；60 秒档 15 片 → status=success / 60.28 秒；日志 `媒体预算 duration=30 budgetMs=2050000`（34 分钟） |
| DEF-108 字数门槛无前置提示 | **Fixed** | 长视频页显示「这条片要 369 字口播稿（4.1 字/秒 × 90 秒，约 18 镜）」；新增门槛接口与一键补写接口 |
| DEF-109 备份轮转误删手工备份 | **Fixed** | `qa/verify-backup-rotation.mjs` 8 checks PASS；`security-backup.spec.ts` 5 passed |
| DEF-110 字数门槛接口被通配路由吃掉 | **Fixed** | 装机版实测 `script-requirement` 返回 1350 字 / 60 镜（300 秒档） |

## 现场证据（用户可见的那一层）

### 内容创作的时长档位：8 个档位都在，选 30 秒留得住

用真实浏览器打开草稿箱、点开「视频时长」弹层，读到的档位按钮是：

```
4 秒 / 5 秒 / 6 秒 / 8 秒 / 10 秒 / 12 秒 / 30 秒 / 1 分钟
```

点「30 秒」之后触发按钮的文案变成 `30 秒`（不是回落默认档）。截图：`qa/evidence/0.2.58-时长档位-30秒.png`。
探针：`node products/bosom-friend/qa/verify-duration-popover.mjs`。

### 30 秒 / 1 分钟档位真的出片（拼装路径，不是图片轮播降级）

| 档位 | 假厂商下单序列 | 成片 | 生成记录 |
| --- | --- | --- | --- |
| 30 秒 | `4,4,4,4,4,4,6`（7 片，合计 30） | `ai-vid-4365ba3f.mp4` 30.14 秒 / 720x1280 | `status=success`、`generatedModel=video:composed:7clips` |
| 1 分钟 | `4×15`（15 片，合计 60） | `ai-vid-0d112157.mp4` 60.28 秒 / 720x1280 | `status=success`、`generatedModel=video:composed:15clips` |

两次都走完 `AI_VID_CLIP 1/7…7/7`、`AI_VID_COMPOSE … adjust=none`，且**没有**落到 `local-template` 降级路径。
原始输出：`qa/reports/gear-30s-installed-2026-09-19.txt`、`qa/reports/gear-60s-installed-2026-09-19.txt`。

### 媒体预算的现场数值（DEF-107 的判据）

```
2026-09-19T06:01:20.871Z [generation] 媒体预算 id=gen-72c01624 kind=video duration=30 budgetMs=2050000
```

2,050,000 ms = 34 分钟 = 7 片 × 250 秒（单片实测上限）+ 5 分钟（拼接开销），与界面给出的诚实预估同源。
旧代码在这里是固定 15 分钟——现场那条 16.5 分钟才拼完的 30 秒成片就是被它判死的。

### 长视频的字数门槛前置（DEF-108）

长视频页「目标时长」下方显示：

```
这条片要 369 字口播稿（4.1 字/秒 × 90 秒，约 18 镜）；不够时后端会自动补写 3 轮，仍不够就停在这一步、不花厂商额度
```

接口（装机版实测）：

```
GET long-videos/script-requirement?producer=scene&targetSeconds=300
-> {"targetSeconds":300,"requiredChars":1350,"charsPerSecond":4.5,"shots":60}
```

## 复现口径（为什么这些结论不是"读代码读出来的"）

- 两条出片验收都用**真实装机版 + 真 ffmpeg + 真 HTTP**：假厂商只负责按秒数造带音轨的片段，
  拼接、时长收敛、状态机、落盘全部由装机版自己完成；
- 每次跑完都核对：厂商收到的下单序列、生成记录状态、成片文件的真实时长（ffmpeg 读 Duration 行）、
  以及"标注为拼装成片而不是降级轮播"；
- 用户的大模型配置在验收前后逐字段比对（地址/型号/密钥都在），测试期间产生的记录与成片已删除。

## 验收期间发现并修掉的附带缺陷

| 缺陷 | 说明 |
| --- | --- |
| DEF-110 | 新加的字数门槛路由被更早注册的 `long-videos/:taskId` 通配路由吃掉，真机返回「任务不存在」——类型检查与单测都发现不了，只有真发一次 HTTP 才暴露 |
| DEF-111 | 发布脚本用 `git credential fill` 取令牌时被 git-credential-manager 的「选择账户」弹窗卡死（现场留下 6 个 git + 2 个 GCM 进程），改为直接 `CredRead` 读 Windows 凭据管理器后上传成功 |

## 回滚网与知识库同步

| 落点 | 状态 |
| --- | --- |
| 本机回滚库 `C:/Users/Jay/BosomFriend-Releases` | 0.2.58（当前出货）+ 0.2.56（回滚目标），0.2.57 退役 |
| GitHub Release `Bill-H9986/zhiyin` | v0.2.51 / v0.2.55 / v0.2.56 / v0.2.57 / v0.2.58 全部 `state=uploaded`，字节数与本机一致 |
| 基线指纹 `qa/baseline/installer-checksums.json` | `files` 已换成 0.2.58 + 0.2.56，0.2.57 进 `retired` |
| 知识库 | `import-dev-knowledge.mjs --apply`：466 篇笔记（新增 9，含本报告与缺陷档案）；条目 15「回滚网与版本回退」已按 0.2.58 更新 |
| 用户数据 | 11 条内容 / 1 条生成记录 / 6 条长视频任务 / 1,141 个素材文件，与验收前完全一致；测试记录与片段已全部删除 |

## 遗留（如实记录，未在本版修）

- `test/functional/video-reference.spec.ts` 的两条用例在 0.2.58 上失败：厂商对图生视频请求返回 400。
  它们走的是真实厂商接口，不经过本次改动的任何代码路径。
- 假厂商每片延迟超过 20 秒时，产品的厂商请求会因自身 20 秒超时（含两次重试）失败并降级——
  这是**厂商侧慢响应**的产品行为，不是本次预算改动引入的；真实厂商的成片耗时是分钟级、请求本身很快返回。
