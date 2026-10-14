r"""
把 pnpm 部署出来的内核运行时压成「扁平 node_modules」树，供打包与压缩使用。

为什么需要它：pnpm 11 的部署产物里，顶层 node_modules 和 .pnpm/<id>/node_modules 下
绝大多数条目是**目录联接点**（reparse point），真实文件只有约 1100 个（实测 22.6 MB），
其余 196.4 MB 全是链接。zip 存不了联接点，于是 repack_kernel.py 把这棵树「展开」成每个
链接各复制一份真实内容，实测 171762~195539 个条目、419 MB 的包，压缩本身要 21 分钟。
而随包发布真正需要的唯一内容，是每个包名各一份真实文件——实测 24044 个文件、222 MB。

扁平层对 Node 的解析规则成立，无需联接点：从 node_modules/<pkg>/lib/x.js 逐级向上找
node_modules/<name>，扁平层就在顶层，任何包都能解析到自己的依赖。实测同一份闭包用 pnpm 的
hoisted 链接器生成后，qa/probes/handshake-kernel.mjs 通过（24044 文件 / 222 MB）。

**版本例外**靠对比「部署产物里真实解析到的版本」判定，不能用 package.json 里的声明区间：
区间与版本不是同一个字符串，按字符串比会把每个依赖都误判成冲突（实测 1011 个，正确值 12 个）。
部署产物的联接点目标写着 pnpm 的版本化目录名，就是真实解析结果。

用法：python flatten_kernel_tree.py <部署产物根> <扁平树输出目录>
"""
import json
import os
import re
import shutil
import sys
import time

# 部署根必须留下的非 node_modules 内容：内核入口、配置、锁文件。
KEEP_ROOT = ('runtime', 'cordis.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
# 必须存在的关键路径：缺任何一条，内核都起不来（与 repack_kernel.py 同一判据）。
REQUIRED = (
    os.path.join('runtime', 'bin-kernel.mjs'),
    os.path.join('runtime', 'bin-desktop.mjs'),
    os.path.join('cordis.yml'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-bosom-friend-kernel', 'package.json'),
)


def package_dirs(node_modules):
    """列出 node_modules 下的包条目：[(名称, 路径)]，跳过 .bin/.pnpm 等点目录。

    @param node_modules - 要扫描的 node_modules 目录。
    @returns 名称到目录的列表；名称是 'name' 或 '@scope/name'。
    """
    found = []
    if not os.path.isdir(node_modules):
        return found
    with os.scandir(node_modules) as entries:
        for entry in entries:
            if entry.name.startswith('.'):
                continue
            if entry.name.startswith('@'):
                if not entry.is_dir(follow_symlinks=False):
                    continue
                with os.scandir(entry.path) as subs:
                    for sub in subs:
                        found.append((entry.name + '/' + sub.name, sub.path))
            else:
                found.append((entry.name, entry.path))
    return found


def package_version(path):
    """读包目录里的 package.json 版本；读不到返回 None。

    @param path - 包目录。
    @returns 版本字符串，或 None。
    """
    try:
        with open(os.path.join(path, 'package.json'), encoding='utf-8') as handle:
            return json.load(handle).get('version')
    except (OSError, ValueError):
        return None


# pnpm 虚拟仓目录名：包名（可带 scope）@版本，后面可能跟 _对等依赖 或 (对等依赖)。
STORE_ID = re.compile(r'^(?:@[^/]+/)?[^/@]+@([^_()]+)')


def store_id_version(path):
    """从 .pnpm 虚拟仓目录名解析版本，例如 .pnpm/foo@1.2.3_peer@4 -> 1.2.3。

    @param path - 已解析成真实路径的包目录。
    @returns 版本字符串，或 None。
    """
    for depth, part in enumerate(reversed(os.path.normpath(path).split(os.sep))):
        # 包目录自身的最后一段只是包名，版本写在它的上一级（虚拟仓目录名）。
        if depth == 0:
            continue
        matched = STORE_ID.match(part)
        if matched:
            return matched.group(1)
    return None


def resolution_key(path):
    """算一个包目录的解析标识：pnpm 虚拟仓目录名优先，否则回落到 package.json 版本。

    @param path - 已解析的包目录。
    @returns 标识字符串；两者都拿不到时返回 None。
    """
    return store_id_version(path) or package_version(path)


def resolved_node_modules(path):
    """取一个 node_modules 条目的解析结果：链接给出目标，真实目录给出自身。

    @param path - node_modules 下的一个包条目。
    @returns 解析后的目录；无法解析时返回 None。
    """
    if os.path.islink(path):
        real = os.path.realpath(path)
        return real if os.path.isdir(real) else None
    return path if os.path.isdir(path) else None


def index_store(pnpm_dir):
    """索引 .pnpm 虚拟仓：每个包名的解析标识到真实目录。

    @param pnpm_dir - 部署根下的 node_modules/.pnpm。
    @returns {名称: {标识: 真实目录}}。
    """
    index = {}
    if not os.path.isdir(pnpm_dir):
        return index
    roots = [os.path.join(pnpm_dir, 'node_modules')]
    with os.scandir(pnpm_dir) as entries:
        for entry in entries:
            if entry.is_dir():
                # 只登记 <虚拟仓目录>/node_modules 这一层（包的兄弟依赖层）。包目录**内部**的
                # node_modules 不登记：那里的条目是其它包的联接点，按名字登记会把同一个包
                # 登记成多个版本，从而在扁平层里凭空多复制几千个文件。
                roots.append(os.path.join(entry.path, 'node_modules'))
    for root in roots:
        for name, path in package_dirs(root):
            resolved = resolved_node_modules(path)
            if resolved is None:
                continue
            identified = resolution_key(resolved)
            if identified:
                index.setdefault(name, {}).setdefault(identified, resolved)
    return index


def resolve_deployed(root, name, stop):
    """按 Node 规则在部署产物里解析一个包名，返回它的解析标识。

    解析必须在部署根（stop）之前停下：Node 在用户机器上只看到解压出来的那棵树，
    越界向上会走到构建机的仓库 node_modules，把工作区里的同名包当成内核的依赖
    （实测把 js-yaml@4.2.0 当成内核解析结果，实际内核只有 4.3.2，凭空多出一批嵌套副本）。

    @param root - 解析起点目录。
    @param name - 包名，'name' 或 '@scope/name'。
    @param stop - 部署根目录；走到它就不再看它的上一级。
    @returns 解析标识；解析不到返回 None。
    """
    current = root
    while True:
        resolved = resolved_node_modules(os.path.join(current, 'node_modules', *name.split('/')))
        if resolved is not None:
            return resolution_key(resolved)
        if os.path.normcase(current) == os.path.normcase(stop):
            return None
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def link_or_copy(src, dst):
    """优先硬链接，失败则复制。硬链接是普通文件，zip 与安装器都不需要特殊处理。

    @param src - 源文件。
    @param dst - 目标文件，父目录需已存在。
    """
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def copy_tree(src, dst, state):
    """把包目录复制成真实文件；包内的 node_modules（联接点）不复制，由版本例外单独处理。

    @param src - 源包目录。
    @param dst - 目标目录。
    @param state - {'files': int, 'bytes': int} 累加器。
    """
    os.makedirs(dst, exist_ok=True)
    with os.scandir(src) as entries:
        for entry in entries:
            target = os.path.join(dst, entry.name)
            if entry.is_symlink():
                real = os.path.realpath(entry.path)
                if os.path.isdir(real) and not os.path.exists(target):
                    copy_tree(real, target, state)
                continue
            if entry.is_dir(follow_symlinks=False):
                if entry.name == 'node_modules':
                    continue
                copy_tree(entry.path, target, state)
                continue
            if os.path.exists(target):
                continue
            link_or_copy(entry.path, target)
            state['files'] += 1
            state['bytes'] += entry.stat().st_size


def plan(deployed, index):
    """规划扁平层与版本例外。

    @param deployed - 部署根目录。
    @param index - index_store 的结果。
    @returns (flat, references)：flat 是 {名称: (真实目录, 标识)}；
             references 是 [(包名, 依赖名, 真实目录)]。
    """
    flat = {}
    # 顶层注入的包优先：工作区包（server/kernel/bundle）不在 .pnpm 里。
    for name, path in package_dirs(os.path.join(deployed, 'node_modules')):
        resolved = resolved_node_modules(path)
        if resolved is not None:
            flat[name] = (resolved, resolution_key(resolved))
    for name, versions in sorted(index.items()):
        if name in flat:
            continue
        identified = next(iter(versions))
        flat[name] = (versions[identified], identified)
    references = []
    for name, (source, _identified) in sorted(flat.items()):
        try:
            with open(os.path.join(source, 'package.json'), encoding='utf-8') as handle:
                dependencies = json.load(handle).get('dependencies') or {}
        except (OSError, ValueError):
            continue
        # 该包在部署产物里真实解析到的依赖目录，就是它自己的 node_modules 所在的那一层。
        from_package = os.path.join(deployed, 'node_modules', *name.split('/'))
        for dep in dependencies:
            wanted = resolve_deployed(from_package, dep, deployed)
            if wanted is None or wanted == flat.get(dep, (None, None))[1]:
                continue
            target = index.get(dep, {}).get(wanted)
            if target is None:
                print('WARN cannot nest %s@%s for %s: not in store' % (dep, wanted, name), file=sys.stderr)
                continue
            references.append((name, dep, target))
    return flat, references


def main():
    """入口：读部署产物，写出扁平树。

    @returns 进程退出码；0 表示扁平树已就绪且通过结构自检。
    """
    if len(sys.argv) < 3:
        print('usage: flatten_kernel_tree.py <deployed-root> <flat-out>', file=sys.stderr)
        return 2
    deployed = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    node_modules = os.path.join(deployed, 'node_modules')
    if not os.path.isdir(node_modules):
        print('missing deployed node_modules: ' + node_modules, file=sys.stderr)
        return 1

    started = time.time()
    flat, references = plan(deployed, index_store(os.path.join(node_modules, '.pnpm')))
    print('flat layer: %d package names, %d nested copies' % (len(flat), len(references)), flush=True)

    if os.path.isdir(out):
        shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for name in KEEP_ROOT:
        source = os.path.join(deployed, name)
        target = os.path.join(out, name)
        if os.path.isdir(source):
            shutil.copytree(source, target)
        elif os.path.isfile(source):
            shutil.copy2(source, target)
    os.makedirs(os.path.join(out, 'node_modules'))

    state = {'files': 0, 'bytes': 0}
    for name, (source, _identified) in sorted(flat.items()):
        copy_tree(source, os.path.join(out, 'node_modules', *name.split('/')), state)
    for name, dep, source in references:
        copy_tree(
            source,
            os.path.join(out, 'node_modules', *name.split('/'), 'node_modules', *dep.split('/')),
            state,
        )
    bin_src = os.path.join(node_modules, '.bin')
    if os.path.isdir(bin_src):
        copy_tree(bin_src, os.path.join(out, 'node_modules', '.bin'), state)

    for relative in REQUIRED:
        if not os.path.exists(os.path.join(out, relative)):
            print('flat tree is missing ' + relative, file=sys.stderr)
            return 1
    print('flat ok: %d packages, %d nested, %d files, %s MB in %ds'
          % (len(flat), len(references), state['files'], round(state['bytes'] / 1048576, 1),
             round(time.time() - started)), flush=True)
    print('flat tree: ' + out, flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
