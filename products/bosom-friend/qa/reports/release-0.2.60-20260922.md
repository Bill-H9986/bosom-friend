# 0.2.60 本机安装 / 升级 / 卸载 / 装回实测（2026-09-22）

> 被测：含本轮全部修复的出包（DEF-161 账号事实地址归一、DEF-162 台账结构、DEF-163 时长药丸判定、DEF-164 数据编码、DEF-165 依赖边界、DEF-166 删不掉最后一个账号、DEF-167 E2E 预算）。
> 判据：AC-020-1（安装版跑通真实业务）、AC-021-2（升级保留数据 / 卸载无残留）。
> **动手前先整树备份数据根**：`%TEMP%\bf-data-backup-20260922-224952`（2,016 文件 / 482.7 MB）。

## 1. 出包

```
desktop/rebuild-kernel-and-installer.ps1  →  DONE（9 步全过）
release\0.2.60\BosomFriend-Setup-0.2.60.exe   743.2 MB   FileVersion=0.2.60
SHA256  49143218CD929D5557A798585EC5051C0DF456B93D952C43EC582C3DC946A287
```

## 2. 升级安装（0.2.59 → 0.2.60）

```
静默安装 /S   exit 0   用时 3.4 分钟
已装 exe                        FileVersion=0.2.60
注册表                          Bosom Friend 0.2.60 / DisplayVersion=0.2.60
内核运行树（%APPDATA%）         23,342 文件
```

**数据是否保留（对照装机前基线）**：

| 项 | 基线 | 升级后 |
| --- | --- | --- |
| 数据根文件数 | 2,016 | 2,016 |
| `bosom-friend\accounts.json` | `93E4E4A8A47C3F3F` | 同 |
| `bosom-friend\knowledge.json` | `937975A709EC4B2B` | 同 |
| `bosom-friend\contents.json` | `5C6ECF971332DB89` | 同 |
| `AGENTS.md` | `B7857A4F1383B095` | 同 |

## 3. 安装版跑真实业务（AC-020-1 的本机半边）

`qa/probes/verify-installed-ai-business.mjs`（端口 31296，真实数据根与真实凭据，真实大模型）：

```
第一次  7 passed (3.9m)
第二次  7 passed (4.1m)   ← 换用 JSON 判定后
用例    AC-004-1（非模板正文）/ AC-016-1（用的就是设置里的模型）/ AC-018-1（对话→导航卡→真的跳转 ×5）
```

**同一轮修掉的探针缺陷**：探针原来按 `npx playwright test` 的退出码判定，实测同一条命令手跑 `exit=0`、
探针里却拿到非 0（7 passed 被判失败）。已改为读 Playwright 配置里那份 JSON 的 `stats`：
`unexpected=0 且 expected>0` 才算 PASS。正负对照：`-g AC-016-1` → `判定：PASS expected=1 unexpected=0`（exit 0）；
模式匹配不到用例 → `判定：FAIL expected=0`（exit 1）。

## 4. 静默卸载（残留检查）

```
卸载 exit 0   用时 0.2 分钟
安装目录（15,684 文件 / 2,365 MB）        已清除
桌面快捷方式 / 开始菜单快捷方式            已清除
注册表项                                  已清除
%APPDATA%\Bosom Friend（23,458 文件 / 238.8 MB）  已清除
数据根                                     2,056 文件，原样保留（accounts.json 哈希不变）
```

## 5. 装回（保证机器可用）

```
静默安装 /S   exit 0   用时 2.2 分钟
已装 exe FileVersion=0.2.60   注册表 Bosom Friend 0.2.60
启动一次：产品页 HTTP 200 ✓（随后按验收脚本同款方式结束进程，不留托盘常驻）
数据根：2,058 文件，accounts.json 哈希仍为 93E4E4A8A47C3F3F
```

## 6. 仍未验（照实写）

- **干净机器侧**（无历史安装、无开发环境的第二台机器）：AC-020-1 与 AC-021-2 的「部分」正是指这一半，本机做不到，不按已验记；
- 卸载后 `%APPDATA%` 是否**零字节**未逐字节比对，只按目录是否存在与顶层条目数判；
- 本次没有验自动更新链路（产品当前口径是「检查更新 + 提示下载页」，不含静默升级）。
