# -*- coding: utf-8 -*-
"""从 vendored sau_cli.py 静态提取 CLI 契约（platform → action → 参数）。
只读，不改 vendored。每次门禁运行时现提取，避免快照本身成为漂移源。

用法: python extract-contract.py <输出json路径>
"""
import ast, json, sys, os

VENDOR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      '..', '..', 'engine', 'social-auto-upload', 'sau_cli.py')

def lit(n): return n.value if isinstance(n, ast.Constant) else None

def main():
    out_path = sys.argv[1]
    tree = ast.parse(open(VENDOR, encoding='utf-8').read())
    platforms, var_platform, var_actions, var_action = {}, {}, {}, {}

    def ensure(p, a):
        platforms[p]['actions'].setdefault(a, {'args': {}, 'required': [], 'runtime': False})
        return platforms[p]['actions'][a]

    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef) and fn.name == 'build_parser':
            for node in ast.walk(fn):
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    tgt = node.targets[0].id; call = node.value
                    if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute):
                        attr = call.func.attr
                        base = call.func.value.id if isinstance(call.func.value, ast.Name) else ''
                        name = lit(call.args[0]) if call.args else None
                        if attr == 'add_parser' and name:
                            if base == 'platform_parsers':
                                platforms.setdefault(name, {'actions': {}}); var_platform[tgt] = name
                            elif base in var_actions:
                                p = var_actions[base]; ensure(p, name); var_action[tgt] = (p, name)
                        elif attr == 'add_subparsers' and base in var_platform:
                            var_actions[tgt] = var_platform[base]
    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef) and fn.name == 'build_parser':
            for node in ast.walk(fn):
                if isinstance(node, ast.For):
                    names = [lit(e) for e in getattr(node.iter, 'elts', [])]
                    for sub in ast.walk(node):
                        if isinstance(sub, ast.Assign) and isinstance(sub.value, ast.Call) and isinstance(sub.value.func, ast.Attribute) and sub.value.func.attr == 'add_parser':
                            bb = sub.value.func.value.id if isinstance(sub.value.func.value, ast.Name) else ''
                            if bb in var_actions:
                                p = var_actions[bb]
                                for nm in [x for x in names if x]:
                                    v = ensure(p, nm)
                                    v['args']['--account'] = {'type': 'str', 'required': True}
                                    v['required'].append('--account'); v['runtime'] = True
    for fn in ast.walk(tree):
        if isinstance(fn, ast.FunctionDef) and fn.name == 'build_parser':
            for node in ast.walk(fn):
                if not isinstance(node, ast.Call): continue
                if isinstance(node.func, ast.Name) and node.func.id == 'add_runtime_flags' and node.args and isinstance(node.args[0], ast.Name):
                    v = var_action.get(node.args[0].id)
                    if v: ensure(v[0], v[1])['runtime'] = True
                    continue
                if not isinstance(node.func, ast.Attribute) or node.func.attr != 'add_argument': continue
                base = node.func.value.id if isinstance(node.func.value, ast.Name) else ''
                v = var_action.get(base)
                if not v: continue
                flag = lit(node.args[0]) if node.args else None
                if not flag: continue
                info = {'type': 'str', 'required': False}
                for kw in node.keywords:
                    if kw.arg == 'required' and lit(kw.value) is True: info['required'] = True
                    if kw.arg == 'type': info['type'] = getattr(kw.value, 'id', 'value')
                slot = ensure(v[0], v[1])
                slot['args'][flag] = info
                if info['required']: slot['required'].append(flag)

    if len(platforms) == 0:
        print('EXTRACTION_FAILED: 未解析出任何平台', file=sys.stderr); sys.exit(2)
    json.dump(platforms, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('platforms=%d actions=%d' % (len(platforms), sum(len(d['actions']) for d in platforms.values())))

main()
