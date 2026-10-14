# 回滚库整理：0.2.61 出货（2026-09-24）

> 口径：回滚网 = **当前出货版本 + 上一版本**（`qa/baseline/installer-checksums.json` 的 policy）。
> 本次动作全部按 qa/RELEASE_CHECKLIST-v1.0.md 的 R8 执行，指纹在动文件之前先实测复算过。

## 存放位置

`C:/Users/Jay/BosomFriend-Releases`（仓库外，基线 `dir` 字段指向它）

## 变更前

| 文件 | 角色 | 大小 | 实测 SHA256 |
| --- | --- | --- | --- |
| BosomFriend-Setup-0.2.58.exe | 当前出货 | 778,900,239 B | B902CF9C29A54BE19E5DD5451746138DC848DE2C4335F70B7CE8BBC7E3B8603D |
| BosomFriend-Setup-0.2.56.exe | 回滚目标 | 778,899,443 B | C939B09FF220A24B7BBBCB4FE577BF694A1B01362F4D60DB65CE2621C72AACAF |

两份都与变更前基线的指纹**逐字节一致**（实测，非照抄）。

## 变更后

| 文件 | 角色 | 大小 | 实测 SHA256 |
| --- | --- | --- | --- |
| BosomFriend-Setup-0.2.61.exe | 当前出货 | 780,938,197 B | 15C1010AC05FAC1502102A1ABE7C068EDD6A7BA7D6ECD2AF6A6FC223F87EDAD5 |
| BosomFriend-Setup-0.2.60.exe | 回滚目标 | 780,334,064 B | 30254EDC37533161D1D65004B78F2E18F7CD18826BDC46871D91D7F950F1EB60 |

新增的 0.2.61 是 **2026-09-24 18:40 重打**的那一份（旧包 `16DB3CE0…` 打在数字人选择器修复之前，
装出来的界面只有数字人口播能选形象，用户会直接看到旧缺陷）。两份都带 `.exe.blockmap`。

## 退役

| 文件 | 退役时间 | 原因 | 第二份来源 |
| --- | --- | --- | --- |
| BosomFriend-Setup-0.2.58.exe | 2026-09-24 | 回滚网只保留当前版与上一版；0.2.60 取代它成为回滚目标 | GitHub Release v0.2.58 |
| BosomFriend-Setup-0.2.56.exe | 2026-09-24 | 它是 0.2.58 的回滚目标，0.2.58 退出回滚网后不再需要 | GitHub Release v0.2.56 |

两份的指纹已写进 `installer-checksums.json` 的 `retired` 与 `qa/baseline/安装包只读保护清单.md`，
取回脚本：`qa/probes/fetch-release-installer.ps1 -Version 0.2.58`（下载后按指纹核对，不通过不落盘）。

## 校验

- 门禁「安装包只读保护」逐文件复算 SHA256：新基线为 2 个文件（0.2.61 current + 0.2.60 rollback-target）；
- 0.2.59 / 0.2.60 从未发布到 GitHub Release，因此本目录是 0.2.60 唯一可直接安装的副本（见 checksums 的 recovery.note）。
