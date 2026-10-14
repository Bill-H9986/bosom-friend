# 安装包清理 —— 只留最新版 0.2.51（2026-09-16）

## 决策来源

用户原话：「桌面安装包只留最新版！」。执行范围与影响如下，逐条留痕。

## 删了什么

| 位置 | 删除内容 | 释放 |
| --- | --- | --- |
| 桌面 | `BosomFriend-Setup-0.2.42.exe` ~ `0.2.50.exe`（9 个副本） | 8.29 GB |
| 仓库 `products/bosom-friend/desktop/release/` | `0.2.42` ~ `0.2.50` 九个产物目录（每个含 `.exe`、`.blockmap`，0.2.48 起另含 `sha256.txt`） | 8.25 GB |
| 回滚库 `C:\Users\Jay\BosomFriend-Releases` | `BosomFriend-Setup-0.2.42.exe`（旧口径的当前版） | 946.8 MB |

合计释放约 **17.5 GB**（C 盘剩余 143.4 GB → **159.9 GB**）。

## 保留了什么

| 位置 | 内容 |
| --- | --- |
| 桌面 | `BosomFriend-Setup-0.2.51.exe`（997.7 MB；SHA256 实测 `1301D7A736168D65F9F2F006705CB6A76A413FE22A33890670B6E5C243329E0E`，与发布报告一致） |
| 仓库 | `desktop/release/0.2.51/`（exe + blockmap + sha256.txt） |
| 回滚库（仓库外） | `BosomFriend-Setup-0.2.51.exe`（当前版） |
| 内核运行时回滚材料 | `desktop/dist/kernel-runtime.zip.bak-0.1.1`（升级前那份可用包，367.1 MB）等 11 份 `.bak-*`，**未动** |

## 与既有口径的偏差（如实）

铁律与基线原文要求回滚网 = **当前出货版 + 上一版**。本轮按用户口径只留最新版，因此：

- **0.2.50 的回滚包不存在了**（桌面、仓库产物目录、回滚库三处都没有；回收站中也没有）；
- 0.2.50 已写入基线 `retired`，保留大小与 SHA256（`335E2BD3…F4C2`）；
- 需要恢复时的唯一路径：用提交 `edeca049`（0.2.50 出包那次）重跑 `desktop/rebuild-kernel-and-installer.ps1`（8 步，40~70 分钟）；
- 0.2.51 与 0.2.50 **内核运行时相同**（0.1.5-rc.2，`SESSION_FORMAT_VERSION = 3`），所以若要回滚运行时，`kernel-runtime.zip.bak-0.1.1` 与当前 zip 都在，缺的只是 0.2.50 那个安装包外壳。

## 基线同步

- `qa/baseline/installer-checksums.json`：`files` → 0.2.51；`retired` 增 0.2.50；`updatedAt` → 2026-09-16；`policy` 写明"用户要求只留最新版时按用户口径执行并留痕"。
- `qa/baseline/安装包只读保护清单.md`：当前版表格替换为 0.2.51，退役表增 0.2.50，变更记录增两行（0.2.51 入库、0.2.42 退役）。


## 补充（同日）：0.2.51 在 GitHub 上作为回滚包

用户口径：「就将 0.2.51 在 GitHub 上作为回滚包！」。落地方式：

- 公开下载仓的 Release 资源即回滚包的**第二份来源**：
  <https://github.com/Bill-H9986/zhiyin/releases/download/v0.2.51/BosomFriend-Setup-0.2.51.exe>
  （1,046,116,194 B，`state=uploaded`，公开；实测可下载、`Content-Length` 与本地一致）
- 新增取回脚本 `qa/probes/fetch-release-installer.ps1`：下载 → 按 `installer-checksums.json` 核对大小与 SHA256 → 通过才落到回滚目录；支持 `-VerifyOnly` 只核对本地、`-Dest` 取到外置盘。
- 基线 `installer-checksums.json` 增 `recovery` 段（渠道 / 资源直链 / 脚本 / 说明），`安装包只读保护清单.md` 同步。

实测（本机）：

```text
OK BosomFriend-Setup-0.2.51.exe  1046116194 B  SHA256 1301D7A736168D65F9F2F006705CB6A76A413FE22A33890670B6E5C243329E0E
```

因此现在的回滚能力是：**本机回滚库 + GitHub Release 双份，都是 0.2.51**；0.2.50 仍然没有包（如需恢复见上文重建路径）。

## 复核

```powershell
Get-ChildItem "$env:USERPROFILE\Desktop" -Filter 'BosomFriend-Setup-*.exe'   # 只剩 0.2.51
Get-ChildItem "products\bosom-friend\desktop\release" -Directory           # 只剩 0.2.51
Get-ChildItem "C:\Users\Jay\BosomFriend-Releases" -File                    # 只剩 0.2.51 + README
```
