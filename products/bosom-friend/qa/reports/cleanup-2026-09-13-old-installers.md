# 旧安装包清理记录（2026-09-13）

## 口径

用户选择 **A 保守**：只删本地历史安装包，保留
- **0.2.42**（当前出货版本）
- **0.2.41**（上一版，回滚用）
- `release/` 下被门禁基线 `qa/baseline/installer-checksums.json` 钉住的 5 个回滚包（0.13.5 / 0.13.6 / 0.13.7 / 0.13.8 / 0.2.0）
- `release/BosomFriend-Setup-0.2.31.exe`（未被保护，但保守档不动）

## 删除清单（实际释放 8.04 GB）

| 位置 | 文件 | 大小(MB) |
| --- | --- | --- |
| 桌面 | BosomFriend-Setup-0.2.33.exe | 411.8 |
| 桌面 | BosomFriend-Setup-0.2.34.exe | 411.8 |
| 桌面 | BosomFriend-Setup-0.2.35.exe | 411.9 |
| 桌面 | BosomFriend-Setup-0.2.36.exe | 1090.8 |
| 桌面 | BosomFriend-Setup-0.2.37.exe | 1090.8 |
| 桌面 | BosomFriend-Setup-0.2.38.exe | 1090.8 |
| 桌面 | BosomFriend-Setup-0.2.39.exe | 1090.8 |
| 桌面 | BosomFriend-Setup-0.2.40.exe | 771.3 |
| desktop/release | 0.2.39/（整个目录） | 1091.9 |
| desktop/release | 0.2.40/（整个目录） | 772.1 |

## 删除后核对

- 桌面只剩 `BosomFriend-Setup-0.2.41.exe`（947MB）与 `BosomFriend-Setup-0.2.42.exe`（947MB）
- `desktop/release/` 只剩 `0.2.41`、`0.2.42`
- `release/` 六个文件未动（门禁「安装包只读保护」检查不受影响）

## 为什么保这些

- 0.2.42 是当前出货版本；0.2.41 是它的回滚版本（AC-020-2 的升级/回滚路径要用）。
- `release/` 里那 5 个是**门禁钉住的回滚安全网**：删掉会让「安装包只读保护」直接变红，
  要删必须先改基线并明确放弃回滚能力（属清理档位 C，本轮未选）。
- 0.2.42 的安装包另有独立副本：`products/bosom-friend/desktop/release/0.2.42/` 与桌面各一份，
  SHA256 `D717EABCAF281427500EF7D8A944C3AFA58BCE41FD5DE5EC771F7A816FA0EDF6`（两份一致）。
