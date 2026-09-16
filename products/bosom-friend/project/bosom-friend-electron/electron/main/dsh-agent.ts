/**
 * 知音 DSH 内核接入 · 实验室窗口
 *
 * 让用户在APP内直接体验 DSH 内核：提问 → 内核执行（含平台工具调用）→ 回答
 * 进程级 sidecar：spawn dsh --profile headless --patch zhiyin-patch.yml
 *
 * 集成位置（无需改主界面）：独立小窗口，菜单/快捷键唤起
 */
import { BrowserWindow, ipcMain, app } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DSH_PROFILE = 'headless';

/** 定位 bridge 包的 patch 文件（开发环境从项目内找） */
function resolvePatchPath(): string {
  const candidates = [
    path.join(app.getAppPath(), '..', '..', 'packages', 'zhiyin-dsh-bridge', 'zhiyin-patch.yml'),
    path.join(app.getAppPath(), 'packages', 'zhiyin-dsh-bridge', 'zhiyin-patch.yml'),
    'C:\\Users\\Jay\\Desktop\\ZhiYin-Ai smart system\\project\\packages\\zhiyin-dsh-bridge\\zhiyin-patch.yml',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* continue */ }
  }
  return candidates[candidates.length - 1];
}

function dshBinPath(): string {
  const exe = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
  const candidates = [
    path.join(app.getAppPath(), '..', '..', 'packages', 'zhiyin-dsh-bridge', 'node_modules', '.bin', exe),
    'C:\\Users\\Jay\\Desktop\\ZhiYin-Ai smart system\\project\\packages\\zhiyin-dsh-bridge\\node_modules\\.bin\\' + exe,
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* continue */ }
  }
  return candidates[candidates.length - 1];
}

export interface DshAskResult {
  ok: boolean;
  text: string;
  durationMs: number;
}

/** 发起一次 DSH 内核任务（进程级，带超时保护） */
export function askDsh(question: string, timeoutMs = 180_000): Promise<DshAskResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const bin = dshBinPath();
    const patch = resolvePatchPath();
    const args = ['--profile', DSH_PROFILE, '--patch', '\\"' + patch + '\\"', question];
    const child = spawn('\\"' + bin + '\\"', args, {
      shell: true,
      env: { ...process.env },
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: '(超时 ' + timeoutMs + 'ms)', durationMs: Date.now() - started });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => chunks.push(d));
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8').replace(/\\r?\\n/gs, '\\n').trim();
      // 剥离PS包装路径等杂讯只保留正文
      const clean = text.split('\\n').filter(line =>
        !line.includes('CategoryInfo') && !line.includes('所在位置') && !line.includes('~~~') && !line.includes('+ ')
      ).join('\\n').trim();
      resolve({ ok: code === 0 || clean.length > 0, text: clean || text, durationMs: Date.now() - started });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: String(err), durationMs: Date.now() - started });
    });
  });
}

/** 注册 IPC：zhiyin:dsh:ask（渲染进程调用） */
export function registerDshIpc(): void {
  ipcMain.handle('zhiyin:dsh:ask', async (_e, question: string) => {
    return await askDsh(String(question || ''));
  });
}

/** 打开 DSH 实验室窗口 */
export function openDshLab(): BrowserWindow {
  const win = new BrowserWindow({
    title: 'Bosom Friend · DSH 内核实验室',
    width: 720,
    height: 760,
    minWidth: 480,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LAB_HTML));
  return win;
}

const LAB_HTML = `
<!DOCTYPE html><html><head><meta charset="utf-8"><title>DSH 实验室</title>
<style>
body{font-family:'Microsoft YaHei',sans-serif;margin:0;background:#f7f8fa;display:flex;flex-direction:column;height:100vh}
#chat{flex:1;overflow-y:auto;padding:16px}
.msg{max-width:85%;margin-bottom:12px;padding:12px 14px;border-radius:10px;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.7}
.user{background:#1677ff;color:#fff;margin-left:auto}
.bot{background:#fff;border:1px solid #e8e8e8}
.meta{font-size:12px;color:#999;margin-top:6px}
.inputbar{display:flex;gap:8px;padding:12px;background:#fff;border-top:1px solid #eee}
input{flex:1;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px}
button{background:#1677ff;color:#fff;border:0;padding:10px 18px;border-radius:8px;cursor:pointer}
button:disabled{background:#a3c4f5}
</style></head><body>
<div id="chat"><div class="msg bot">欢迎使用 Bosom Friend 内核实验室！试试：<br>1. 有哪些账号？<br>2. 抖音运营应该注意什么？<br>3. 帮我写一条小红书种草文案。</div></div>
<div class="inputbar"><input id="q" placeholder="向 DSH 内核提问…"><button id="send">发送</button></div>
<script>
const c=document.getElementById('chat'),q=document.getElementById('q'),s=document.getElementById('send');
function add(cls,text,meta){const d=document.createElement('div');d.className='msg '+cls;d.textContent=text;if(meta){const m=document.createElement('div');m.className='meta';m.textContent=meta;d.appendChild(m)}c.appendChild(d);c.scrollTop=c.scrollHeight}
s.onclick=async()=>{const t=q.value.trim();if(!t)return;add('user',t);q.value='';s.disabled=true;add('bot','思考中…','');
try{const r=await window.ipcRenderer.invoke('zhiyin:dsh:ask',t);const rb=document.querySelector('.msg.bot:last-of-type');rb.textContent=r.text||'(空)';rb.appendChild(Object.assign(document.createElement('div'),{className:'meta',textContent:(r.durationMs/1000).toFixed(1)+'s 已完成'}))}catch(e){add('bot','错误: '+e.message)}finally{s.disabled=false}};
q.onkeydown=e=>{if(e.key==='Enter')s.onclick()};
</script></body></html>`;
