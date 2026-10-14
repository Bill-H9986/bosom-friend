# 27 临时目录拼出相对路径：`undefined/` 目录与凭据泄漏

> 来源：2026-10-12 深夜通宵任务（git 提交批次）实测；当时用脚本建隔离数据根，脚本在 `process.env.TEMP/TMP` 都取不到的环境里调 `os.tmpdir()`。
> 关联：本条的现场处置见工作日志；同类问题（把"取不到"当成合法值继续用）在项目里出现过多次（DEF-280/281/282 都是"取值失败被静默跳过"）。

## 现象

在**环境变量为空的 Node 进程**里调 `os.tmpdir()`，返回的不是绝对路径，而是一个**含 `undefined` 的相对路径**（实测拼成 `undefined/temp/…`）。任何"取临时目录 → `path.join` → 建数据根"的代码，落到这里就会把目录创建在**当前工作目录**下——也就是仓库根。

实测落点：`<repo>/undefined/temp/bf-e2e-1791785534170/`，里面有：

- `.agent-presets/roles.json`（工具面事实源的副本）
- `bosom-friend/llm-user.json`（**真实大模型 API Key**）

## 为什么危险

1. **密钥落进工作区**：那份 `llm-user.json` 带真实 Key。它出现在 `git status` 里只是一个不起眼的目录名，**一旦有人 `git add -A` 就会把真实 Key 写进提交历史**；本仓库远端是公开的 `github.com/deepseek-ai/deepseek-harness`，推上去等于泄漏。
2. **没有报错**：`mkdirSync` 在相对路径上一样成功，脚本继续跑完，全程没有任何异常——只能靠人事后翻目录才发现。
3. **会复现**：只要再有脚本在"环境变量不完整"的进程里取临时目录（子进程、CI、被 `spawn` 时 `env` 只传了几个键），同样的目录会再次出现。

## 怎么自查

```powershell
# 1. 工作区里有没有 undefined 目录（含子目录）
Get-ChildItem -Recurse -Directory -Filter undefined -ErrorAction SilentlyContinue | Select-Object FullName
# 2. git 视角：它是不是已经在待提交列表里
git status --short | Select-String 'undefined'
# 3. 顺带确认没有别的"取值失败被当合法值"的残留
git status --short | Select-String 'null|NaN'
```

发现后的处置：先确认里面有没有凭据（`llm-user.json`、`.credentials.yaml`、cookies），**直接删除整个目录**（它是误建的数据根，不是产品数据），再检查 `git status` 是否干净。

## 怎么防

1. **拼接前校验**（最小改动、最有效）：
   ```js
   const tmp = os.tmpdir()
   if (typeof tmp !== 'string' || tmp === '' || tmp.includes('undefined') || !path.isAbsolute(tmp)) {
     throw new Error('临时目录不可用：' + JSON.stringify(tmp))
   }
   ```
   判据是**"是不是绝对路径"**，不是"有没有报错"——`os.tmpdir()` 不会抛。
2. **显式传路径**：脚本自己接受一个绝对路径参数（例如 `--home <abs>`），缺省才回退 `os.tmpdir()`；一次性诊断脚本尤其应该这样。
3. **给子进程补全环境**：用 `spawn` 起子进程时不要手搓一个只有两三键的 `env`，至少带上 `SystemRoot`/`TEMP`/`TMP`（本次就是在这样构造的 env 下暴露的）。
4. **凭据永远不进工作区**：隔离数据根只放**脱敏副本**（或干脆不复制 `llm-user.json`/`.credentials.yaml`），需要真 Key 时从环境变量读。

## 一句话口诀

**取不到就当错误抛，别当值用**——`undefined` 一旦被拼进路径，它就是一个合法的目录名。
