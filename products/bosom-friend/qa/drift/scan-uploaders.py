# -*- coding: utf-8 -*-
"""扫描 uploader 实现：提取**可证明的反例**证据（不推测可用性）。

只回答两个可证伪的问题：
  1) 类的方法里是否存在确定的 NotImplementedError 路径（实现被明确阻断）
  2) 该类是否出现在统一发布 CLI 的引用链里（可识别执行入口）
输出 JSON 给 Node 侧判定；本脚本不下结论。
"""
import ast, json, os, sys

ENGINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'engine')
UPLOADER = os.path.join(ENGINE, 'social-auto-upload', 'uploader')
CLI = os.path.join(ENGINE, 'social-auto-upload', 'sau_cli.py')
FUNC = (ast.FunctionDef, ast.AsyncFunctionDef)

def scan_classes(root):
    out = {}
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d)
        if not os.path.isdir(p): continue
        main = None
        for f in ('main.py', 'main_chrome.py'):
            q = os.path.join(p, f)
            if os.path.exists(q): main = q; break
        if not main: continue
        try:
            src = open(main, encoding='utf-8').read()
            tree = ast.parse(src)
        except Exception as e:
            out[d] = {'error': type(e).__name__ + ': ' + str(e)[:80]}; continue
        classes = {}
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef): continue
            methods, blocked = {}, []
            for m in node.body:
                if not isinstance(m, FUNC): continue
                nie = []
                for sub in ast.walk(m):
                    if isinstance(sub, ast.Raise) and isinstance(sub.exc, ast.Call):
                        fn = sub.exc.func
                        nm = fn.id if isinstance(fn, ast.Name) else (fn.attr if isinstance(fn, ast.Attribute) else '')
                        if 'NotImplemented' in nm: nie.append(sub.lineno)
                methods[m.name] = {'line': m.lineno, 'blockedAt': nie}
                if nie: blocked.append({'method': m.name, 'line': m.lineno, 'raiseAt': nie})
            classes[node.name] = {'line': node.lineno, 'methodCount': len(methods), 'blocked': blocked}
        out[d] = {'file': os.path.relpath(main, ENGINE).replace(os.sep, '/'), 'classes': classes}
    return out

def scan_cli(path):
    """CLI 引用链：import 的类名、以及被实例化的类名。"""
    if not os.path.exists(path): raise FileNotFoundError(path)
    src = open(path, encoding='utf-8').read()
    tree = ast.parse(src)
    imported, instantiated = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            for a in node.names: imported.add(a.name)
        if isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Name): instantiated.add(f.id)
    return {'imported': sorted(imported), 'instantiated': sorted(instantiated)}

def main():
    out_path = sys.argv[1]
    if not os.path.isdir(UPLOADER): raise SystemExit('EXTRACTION_FAILED: uploader 目录不存在')
    data = {'uploaders': scan_classes(UPLOADER), 'cli': scan_cli(CLI)}
    if not data['uploaders']: raise SystemExit('EXTRACTION_FAILED: 未扫描到任何 uploader 目录')
    with open(out_path, 'w', encoding='utf-8') as fh: json.dump(data, fh, ensure_ascii=False)
    print('uploaders=%d imported=%d instantiated=%d' % (len(data['uploaders']), len(data['cli']['imported']), len(data['cli']['instantiated'])))

main()