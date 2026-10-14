# Agnes 官方媒体工具（原样搬运）

来源：`AgnesAI-Labs/agnet-skills-cn` 仓库的 `create-video` skill（官方开源）。

| 文件 | 用途 |
| --- | --- |
| `media_ops.py` | 官方媒体操作库：probe / concat / trim / **contact-sheet** / extract-frame / **burn-subtitles** / add-audio / **mix-audio-timeline** |
| `tts.py` | 官方本地 TTS（旁白合成） |
| `references/*.md` | 官方制作指导、质量审核标准、本地媒体工具用法 |
| `SKILL.md` | 官方视频创作工作流规范（本产品内容创作板块的对标依据） |

**搬运原则**：脚本与参考文档**原样保留**，不改官方实现——
产品侧的调用封装写在 `server/src/agnes-media.ts`，两者分开，
将来官方更新时可以直接替换本目录（见 `local-media-tools.md` 的升级口径）。

搬运日期：2026-09-28。
