r"""
重打内核运行时压缩包：把 dist/kernel-runtime-unpacked 打成一个 zip，
供安装器解压到 %APPDATA%\Bosom Friend\kernel-runtime。

为什么要自己写：这份脚本原先住在 desktop/dist/ 里，而 dist/ 是构建产物目录
（知识库 01 §46：产物放在会被清理的地方 = 没有产物），随清理一起没了。
它做的事很简单，所以直接固化在源码侧，不再放回会被清掉的地方。

pnpm 11 的部署产物为什么不能直接打包（2026-09-16 实测，两次失败）：
依赖是通过 Windows 目录联接点（reparse point）挂上来的——
    node_modules/@deepseek-ai/<pkg>            -> .pnpm/<pkg>@<hash>/node_modules/@deepseek-ai/<pkg>
    .pnpm/<pkg>@<hash>/node_modules/<dep>      -> .pnpm/<dep>@<ver>/node_modules/<dep>
Node 解析靠的是**真实路径**：加载 node_modules/@deepseek-ai/dsh-app-boot/lib/index.js 时，
realpath 落到 .pnpm/<hash>/node_modules/@deepseek-ai/dsh-app-boot/，于是它的依赖在
.pnpm/<hash>/node_modules/（兄弟层）里找得到。这条链有两个前提，zip 都不能满足：

1. **zip 存不了联接点**，Python 的 os.scandir / os.walk 也不穿透它。实测：压缩包只有
   24741 个条目，解压后顶层链接包下面只剩 .bin，内核启动即
   Cannot find package 'js-yaml'。
2. **把联接点展开成真实目录，解析链依然会断**：展开后 realpath 落在顶层路径上，
   Node 从顶层逐级向上找 node_modules，而 .pnpm/<hash>/node_modules 这个兄弟层
   根本不在顶层的祖先链上——js-yaml 在 zip 里、却不在能找到的位置。这解释了为什么
   单纯的「展开联接点」不够（补记 9 的 171301 条目包解压后照样报同一个错）。

所以打包分两步（都是构建期行为，用户机器上只是一棵普通目录树）：

- **展开**：整树复制到临时目录，每个联接点复制它指向的真实内容（copy_expanding）。
  展开必须自己走目录：shutil.copytree 拿 os.readlink 的返回值判断链接是否悬空，而
  pnpm 写的是**相对**目标，相对路径按当前工作目录解析必然判为悬空，于是
  ignore_dangling_symlinks=True 会把每个链接静默跳过（实测整棵树只剩顶层 4 个条目，
  脚本还报成功）；robocopy /E 同样不展开 .pnpm 兄弟层的联接点。
- **补齐扁平层**：把 pnpm 自己算好的扁平兜底层（.pnpm/node_modules，即
  hoist-pattern 默认 '*' 的私有提升层，实测 387 个包）搬到顶层 node_modules，
  与顶层已有的 130 个工作区包合起来正好是闭包全集（517 个名字）。任何包从顶层
  逐级向上都能解析到。版本与扁平层不一致的边（实测 534 个分组里只有极少数）
  按包嵌套补一份到 <包>/node_modules/<依赖>：Node 先看包内的 node_modules，
  所以嵌套副本优先，冲突不会串味。

即使补齐了扁平层，**.pnpm 虚拟仓仍然整份保留**：包之间的精确版本关系写在目录层级里，
删掉它只留一层扁平 node_modules 会把 17 个多版本包的解析搞错。

用法：python repack_kernel.py <dist目录> [--keep-join] [--reuse-join]
"""
import json
import os
import shutil
import sys
import time
import zipfile

JOIN = 'kernel-runtime-join'
# 展开并补齐后必须存在的关键路径：解压出来缺任何一条，内核都起不来。
REQUIRED = [
    os.path.join('runtime', 'bin-kernel.mjs'),
    os.path.join('runtime', 'bin-desktop.mjs'),
    os.path.join('cordis.yml'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-bosom-friend-kernel', 'package.json'),
    # 部署根自己的包（bundle）与被间接依赖的包只出现在 .pnpm 里：pnpm 的顶层层级
    # 只挂部署根 package.json 的直接依赖（实测 130 个），server 这类在 .pnpm/<hash> 下。
    os.path.join('node_modules', '.pnpm'),
]
# 展开是「每个链接各复制一份目标」，条目数会明显多于源树；越过这个上限说明
# 目录里出现了环（链接指回祖先），继续跑只会把磁盘写满。
MAX_FILES = 3000000


def iter_packages(node_modules: str):
    """列出 node_modules 下的包条目：('name' 或 '@scope/name', 路径)。"""
    if not os.path.isdir(node_modules):
        return
    with os.scandir(node_modules) as entries:
        for entry in entries:
            if entry.name == '.bin' or entry.name.startswith('.'):
                continue
            if entry.name.startswith('@') and entry.is_dir(follow_symlinks=False):
                with os.scandir(entry.path) as subs:
                    for sub in subs:
                        yield entry.name + '/' + sub.name, sub.path
            else:
                yield entry.name, entry.path


def copy_expanding(src: str, dst: str, state: dict) -> None:
    """把 src 复制到 dst，遇到链接就复制它指向的真实内容。

    @param src - 源目录。
    @param dst - 目标目录，不存在则创建。
    @param state - 跨递归共享的计数与环检测栈：{'files': int, 'stack': set}。
    """
    os.makedirs(dst, exist_ok=True)
    with os.scandir(src) as entries:
        for entry in entries:
            target = os.path.join(dst, entry.name)
            if entry.is_symlink():
                resolved = os.path.realpath(entry.path)
                if not os.path.exists(resolved):
                    raise RuntimeError('dangling link: ' + entry.path)
                if os.path.isdir(resolved):
                    if resolved in state['stack']:
                        raise RuntimeError('link cycle at ' + entry.path)
                    state['stack'].add(resolved)
                    try:
                        copy_expanding(resolved, target, state)
                    finally:
                        state['stack'].discard(resolved)
                else:
                    shutil.copy2(resolved, target)
                    state['files'] += 1
            elif entry.is_dir(follow_symlinks=False):
                copy_expanding(entry.path, target, state)
            else:
                shutil.copy2(entry.path, target)
                state['files'] += 1
            if state['files'] > MAX_FILES:
                raise RuntimeError('expanded tree is bigger than ' + str(MAX_FILES) + ' files; a link cycle is likely')


def plan_flat_layer(src: str) -> tuple:
    """算出顶层扁平层（名字 -> 真实目录）与按包嵌套的版本例外。

    @param src - 部署产物根目录。
    @returns (flat, exceptions)；exceptions 是 (包名, 依赖名, 真实目录) 三元组列表。
    """
    node_modules = os.path.join(src, 'node_modules')
    pnpm = os.path.join(node_modules, '.pnpm')
    flat = {}
    for name, path in iter_packages(os.path.join(pnpm, 'node_modules')):
        flat.setdefault(name, os.path.realpath(path))
    for name, path in iter_packages(node_modules):
        flat.setdefault(name, os.path.realpath(path))
    exceptions = []
    for entry in os.scandir(pnpm):
        if not entry.is_dir():
            continue
        self_name = None
        deps = []
        for name, path in iter_packages(os.path.join(entry.path, 'node_modules')):
            if os.path.islink(path):
                deps.append((name, os.path.realpath(path)))
            else:
                self_name = name
        if self_name is None:
            continue
        for name, resolved in deps:
            if flat.get(name) != resolved:
                exceptions.append((self_name, name, resolved))
    return flat, exceptions


def count_links(root: str, limit: int = 5) -> list:
    """列出树里前 limit 个联接点/符号链接（不穿透，只看链接自身）。"""
    found = []
    stack = [root]
    while stack and len(found) < limit:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                found.append(entry.path)
                if len(found) >= limit:
                    break
            elif entry.is_dir(follow_symlinks=False):
                stack.append(entry.path)
    return found


def unresolved_from(package_dir: str, dependencies: dict) -> list:
    """按 Node 的规则从一个包目录向上找它声明的依赖，返回找不到的名字。"""
    missing = []
    for name in dependencies:
        current = package_dir
        found = False
        while True:
            if os.path.exists(os.path.join(current, 'node_modules', name)):
                found = True
                break
            parent = os.path.dirname(current)
            if parent == current:
                break
            current = parent
        if not found:
            missing.append(name)
    return missing


def main() -> int:
    args = [item for item in sys.argv[1:] if not item.startswith('--')]
    keep_join = '--keep-join' in sys.argv[1:]
    # 展开 32k 条源条目要三分钟以上；调打包逻辑时用 --reuse-join 复用上一轮的展开结果。
    reuse_join = '--reuse-join' in sys.argv[1:]
    # 只把树整好、不压缩（调解析问题时先跑握手，省一次十分钟的打包）。
    skip_zip = '--skip-zip' in sys.argv[1:]
    keep_join = keep_join or skip_zip
    dist = args[0] if args else os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(dist, 'kernel-runtime-unpacked')
    joined = os.path.join(dist, JOIN)
    out = os.path.join(dist, 'kernel-runtime.zip.new')
    if not os.path.isdir(src):
        print('missing source dir: ' + src, file=sys.stderr)
        return 1

    started = time.time()
    state = {'files': 0, 'stack': set()}
    if reuse_join and os.path.isdir(joined):
        print('reusing expanded tree at ' + joined, flush=True)
    else:
        print('expand: ' + src + ' -> ' + joined, flush=True)
        if os.path.isdir(joined):
            shutil.rmtree(joined, ignore_errors=True)
        copy_expanding(src, joined, state)
        print('  expanded ' + str(state['files']) + ' files in ' + str(round(time.time() - started)) + 's', flush=True)

    flat, exceptions = plan_flat_layer(src)
    added = 0
    for name, resolved in sorted(flat.items()):
        target = os.path.join(joined, 'node_modules', *name.split('/'))
        if os.path.exists(target):
            continue
        copy_expanding(resolved, target, state)
        added += 1
    for self_name, dep_name, resolved in exceptions:
        target = os.path.join(joined, 'node_modules', *self_name.split('/'), 'node_modules', *dep_name.split('/'))
        if os.path.exists(target):
            continue
        copy_expanding(resolved, target, state)
        added += 1
    print(
        '  flat layer: ' + str(len(flat)) + ' names, ' + str(added) + ' copies added, '
        + str(len(exceptions)) + ' version exceptions in ' + str(round(time.time() - started)) + 's',
        flush=True,
    )

    leftover = count_links(joined)
    if leftover:
        # 展开后的树里不该再有链接：zip 存不了它，漏一个就是用户机器上少一批依赖。
        print('expanded tree still holds links: ' + str(leftover), file=sys.stderr)
        return 1
    for relative in REQUIRED:
        if not os.path.exists(os.path.join(joined, relative)):
            print('packed tree is missing ' + relative, file=sys.stderr)
            return 1
    # 顶层包能不能按 Node 的规则解析到自己的依赖——这正是「解压后 Cannot find package
    # 'js-yaml'」的判据，扁平层补齐与否在这里一眼看出。
    entry_pkg = os.path.join(joined, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    with open(os.path.join(entry_pkg, 'package.json'), encoding='utf-8') as handle:
        declared = json.load(handle).get('dependencies', {})
    missing = unresolved_from(entry_pkg, declared)
    if missing:
        print('dsh-app-boot cannot resolve: ' + ', '.join(missing), file=sys.stderr)
        return 1

    if skip_zip:
        # 调试用：先把树整好、直接对着它跑握手探针，省掉一次十分钟的压缩。
        print('skip-zip: tree ready at ' + joined + ' (' + str(round(time.time() - started)) + 's)')
        return 0

    count = 0
    root = os.path.abspath(joined)
    try:
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for walk_root, _dirs, files in os.walk(root):
                for name in files:
                    full = os.path.join(walk_root, name)
                    rel = os.path.relpath(full, root).replace('\\', '/')
                    try:
                        archive.write(full, rel)
                    except OSError as error:
                        # 单个文件读不到就让整包失败：缺文件的运行时会在用户机器上以
                        # 「内核起不来」的形式爆出来，比在这里失败难查得多。
                        print('failed on ' + rel + ': ' + str(error), file=sys.stderr)
                        return 1
                    count += 1
                    if count % 40000 == 0:
                        print('  packed ' + str(count) + ' files, ' + str(round(time.time() - started)) + 's', flush=True)
    finally:
        if not keep_join:
            shutil.rmtree(joined, ignore_errors=True)
        else:
            print('kept expanded tree at ' + joined)

    size_mb = round(os.path.getsize(out) / 1024 / 1024, 1)
    print('repack ok: ' + str(count) + ' files -> ' + out + ' (' + str(size_mb) + ' MB, ' + str(round(time.time() - started)) + 's)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
