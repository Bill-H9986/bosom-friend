# 门禁红绿灯报告

- 时间：2026-09-26T12:50:17.961Z
- 执行方式：快速门禁
- Git 提交：unknown
- 执行人：Jay
- 主机：DESKTOP-2OHKO6T
- 结论：红灯：禁止合并 / 发布

## 检查结果

### [绿] DSH 内核组合（启动器）

dsh-base 已挂载，未发现 dsh-web-app / dsh-client-*。

```
C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\launcher\src\bin-kernel.ts
```

### [绿] DSH 内核入口（并行新路径）

内核入口组合正确：dsh-base + dsh-bosom-friend-kernel，无 Web UI。

```
C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\launcher\src\bin-kernel.ts
```

### [绿] 禁止直连模型接口

所有模型调用（文本/图片/视频/语音）都经官方 DSH 内核。

### [绿] 依赖边界（禁 DSH Web UI 包）

未发现 dsh-web-app / dsh-client-ui 系列依赖。

### [绿] 追溯结构完整性

所有已登记 AC 行结构合规。

### [绿] 功能完整性（未实现清零）

无未实现功能。

### [绿] 验收准则覆盖率

覆盖率 100%（56 条 AC）。

### [绿] 缺陷闭环留痕

已登记缺陷 178 条，关闭字段合规。

### [红] 数据编码完整性

编码损坏未修复（退出码 null）。

### [绿] 安装包只读保护

2 个回滚安装包与基线一致（存放目录 C:/Users/Jay/BosomFriend-Releases）。

### [红] AI 智能体任务动作

退出码 null：存在失败断言。

### [红] 模型配置链路

超时被打断（10 分钟预算用尽）：这一项要单独留时间。

### [红] 业务域 CRUD 四步

退出码 null：存在失败断言。

### [红] 知识库蒸馏链路

退出码 null：存在失败断言。

### [红] 服务端功能测试

超时被打断（12 分钟预算用尽）：这一项要单独留时间，不能与其他重检查并行。

### [红] 前端单元测试

退出码 null：存在失败用例。

### [红] 界面文案完整性

退出码 null：键缺失或占位符不会被替换。

### [红] cordis 补丁一致性

退出码 null：存在漂移。

### [红] 启动页进度条

退出码 null：存在失败断言。

### [红] 性能档位判定

退出码 null：存在失败断言

### [红] 内核握手超时

退出码 null：存在失败断言

### [黄] 内核 bundle 新鲜度

内核产物早于源文件：构建吃到了陈旧输入（先 pnpm install 再重建）。

```


```

### [红] 内核运行时兜底解压

退出码 null：存在失败断言

### [红] 运行可诊断性

退出码 null：存在失败断言

### [红] 日志模块进包

退出码 null：存在失败断言

### [红] 生成任务停滞兜底

退出码 null：存在失败断言

### [红] 内核运行日志

退出码 null：存在失败断言

### [红] 视频时长规划

退出码 null：存在失败断言

### [红] 多片段拼接与时长收敛

退出码 null：存在失败断言

### [红] 视频档位接线

退出码 null：存在失败断言

### [红] 抖音真实播放量采集

退出码 null：存在失败断言

### [红] 内核工具可执行

有工具跑不起来（注册正常但 execute 抛错，模型一调就是崩溃）：仓库构建产物：退出码 null；

```
仓库构建产物：退出码 null；
```

### [红] 有效工具面

工具面回归：默认场景失败（出现不该有的工具）；纯文本场景失败（仍有 ? 个工具）

```

---

```

### [红] 前端产物新鲜度

前端产物落后于源码：页面与出包用的都是旧界面，跑一次 vite build --mode=test。

### [红] 缺陷台账结构

台账结构坏了：单元格里的竖线要转义成 \|，行尾不能吞掉分隔符，编号不能重复。

### [红] 对标看齐

对标基线或关键文档没看齐：按基线 §4 补齐判据状态与「对标定位」段。

### [红] 动作叫法一致

动作规格或文案两侧不一致：按 qa/verify-action-naming.mjs 点名的条目改。

### [红] 韵律真机对账

缺少 qa/probes/verify-prosody-beats.mjs。

```
C:\Users\Jay\Desktop\Bosom friend APP\products\bosom-friend\qa\probes\verify-prosody-beats.mjs
```

### [黄] VLOG 跨镜一致性（证据项）

30 分钟内没跑完（厂商排队慢），本轮没拿到结论。

### [红] 产品包类型

有产品包没过类型检查：服务端：；内核包：；前端：退出码 null

```
服务端：
内核包：
前端：退出码 null
```

### [红] 内核包单测

内核包自带单测没跑通：drafts-consistency.test.mjs：退出码 null；；jobs.test.mjs：退出码 null；；runner.test.mjs：退出码 null；

```
drafts-consistency.test.mjs：退出码 null；
jobs.test.mjs：退出码 null；
runner.test.mjs：退出码 null；
```

### [红] 开发文档索引

文档索引与目录不一致：

### [红] 专业 E2E 套件

退出码 null：存在失败用例。

### [红] 中断时序矩阵

退出码 null：存在失败断言。

### [黄] S 级前端验收

未执行：需要 --full，且应用处于可运行状态。

### [红] 产品版本单源一致

版本号漂移：安装包、页面、服务或注册表不一致（禁止发布）。
