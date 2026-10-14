r"""
把内核运行时打成一个 zip，供安装器解压到 %APPDATA%\Bosom Friend\kernel-runtime。

压缩源是 flatten_kernel_tree.py 产出的「扁平树」：每个包名各一份真实文件，没有目录联接点。
zip 存不了联接点，所以压缩源必须先是扁平树（实测 23297 个条目、62.5 MB，level 6 压缩
120 秒）；直接压 pnpm 的部署产物要先把 171762 个链接目标各复制一份，实测 195539 个条目、
419 MB、1265 秒，条目数与体积都多出一个数量级。

用法：python repack_kernel.py <dist目录> [--source <扁平树>]
     默认压缩源是 <dist目录>/kernel-runtime-flat，输出 <dist目录>/kernel-runtime.zip.new。
"""
import os
import shutil
import sys
import time
import zipfile

# 解压出来必须存在的关键路径：缺任何一条，内核都起不来。
REQUIRED = (
    os.path.join('runtime', 'bin-kernel.mjs'),
    os.path.join('runtime', 'bin-desktop.mjs'),
    os.path.join('cordis.yml'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'),
    os.path.join('node_modules', '@deepseek-ai', 'dsh-bosom-friend-kernel', 'package.json'),
)
# 已经压过的容器格式：再 deflate 一次几乎不缩体积，只烧时间。
STORED_SUFFIXES = ('.zip', '.7z', '.gz', '.tgz', '.png', '.jpg', '.jpeg', '.woff', '.woff2')


def find_links(root: str, limit: int = 5) -> list:
    """列出树里前 limit 个联接点/符号链接（不穿透，只看链接自身）。

    @param root - 扁平树根目录。
    @param limit - 最多返回几个。
    @returns 链接路径列表。
    """
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


def main() -> int:
    """入口：校验扁平树并压缩。

    @returns 进程退出码；0 表示 zip 已产出且通过结构自检。
    """
    args = [item for item in sys.argv[1:] if not item.startswith('--')]
    dist = args[0] if args else os.path.dirname(os.path.abspath(__file__))
    source = args[1] if len(args) > 1 else os.path.join(dist, 'kernel-runtime-flat')
    out = os.path.join(dist, 'kernel-runtime.zip.new')
    if not os.path.isdir(source):
        print('missing flat tree: ' + source + ' (run flatten_kernel_tree.py first)', file=sys.stderr)
        return 1

    started = time.time()
    leftover = find_links(source)
    if leftover:
        # zip 存不了链接：漏一个就是用户机器上少一批依赖。
        print('flat tree still holds links: ' + str(leftover), file=sys.stderr)
        return 1
    for relative in REQUIRED:
        if not os.path.exists(os.path.join(source, relative)):
            print('flat tree is missing ' + relative, file=sys.stderr)
            return 1

    count = 0
    root = os.path.abspath(source)
    try:
        with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for walk_root, _dirs, files in os.walk(root):
                for name in files:
                    full = os.path.join(walk_root, name)
                    rel = os.path.relpath(full, root).replace('\\', '/')
                    try:
                        if name.lower().endswith(STORED_SUFFIXES):
                            archive.write(full, rel, compress_type=zipfile.ZIP_STORED)
                        else:
                            archive.write(full, rel)
                    except OSError as error:
                        # 单个文件读不到就让整包失败：缺文件的运行时会在用户机器上以
                        # "内核起不来"的形式爆出来，比在这里失败难查得多。
                        print('failed on ' + rel + ': ' + str(error), file=sys.stderr)
                        return 1
                    count += 1
                    if count % 40000 == 0:
                        print('  packed ' + str(count) + ' files, ' + str(round(time.time() - started)) + 's', flush=True)
    finally:
        pass

    size_mb = round(os.path.getsize(out) / 1048576, 1)
    print('repack ok: ' + str(count) + ' files -> ' + out + ' (' + str(size_mb) + ' MB, ' + str(round(time.time() - started)) + 's)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
