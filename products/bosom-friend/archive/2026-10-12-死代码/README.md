# 归档 · 前端死代码（2026-10-12）

本目录存放**经复核确认为零引用**的前端死代码。归档而非直接删除的理由：
产品负责人 2026-10-12 拍板的口径是「前端死代码簇 → 归档（可追溯）」，qa 的一次性探针才直接删。

## 重要教训：审计的「不可达」判定不能直接当作「可以删」

八路审计的前端路用**静态 import 图**判定可达性，把下面这些**活页面**误判成了死代码：

| 被误判的簇 | 实际是 | 为什么静态分析看不出来 |
| --- | --- | --- |
| `app/[lng]/ai-social/**` | **首屏**（`SystemIntroPage` 渲染它） | `dynamic(() => import('../app/[lng]/ai-social/AiSocialPageContent'))` |
| `app/[lng]/data-statistics/DataStatisticsClient.tsx` | 数据中心页 | 同样是 `dynamic(...)` 动态导入 |
| `app/[lng]/ai-interaction/AiInteractionClient.tsx` | AI 互动页 | 同上 |
| `app/[lng]/hot-content/**` | AI 互动页的「热榜」标签 | 被 AiInteractionClient import，而后者是动态导入 |

**若按那份清单直接删，首屏、数据中心、AI 互动三页会当场全崩。**
教训：**删文件前的判据必须是"运行时是否真的渲染"，不能只看静态 import 图**；
动态导入（`dynamic(() => import(...))`，路径常含 `[lng]` 这类方括号）是静态分析的盲区。

## 本目录内容

| 归档项 | 原路径 | 复核方式 | 结论 |
| --- | --- | --- | --- |
| `app-layout-MobileNav/`（10 文件） | `project/bosom-friend-web/src/app/layout/MobileNav/**` | 静态 import 只有簇内互引（`MobileNavList → MobileNavItem`、`components/index → MobileNavList`）；动态 import **0 条**；JSX 使用只在簇内 | 真死（桌面 APP 无移动形态） |

归档后前端构建 exit 0（见工作日志 2026-10-12）。
