function setText(role, text) {
  const el = document.querySelector('[data-role="' + role + '"]')
  if (el) el.textContent = text
}

function setOpen(role, open) {
  const el = document.querySelector('[data-role="' + role + '"]')
  if (el) el.setAttribute('data-open', open ? 'true' : 'false')
}

/**
 * 启动进度：只渲染主进程上报的真实里程碑。
 *
 * 百分比单调不减（迟到的事件不得让进度回退）；测不出长度的阶段标记 indeterminate，
 * 进度条走条纹动画并把百分比冻结在阶段起点，同时显示已用时——不用时间假装进度。
 */
let lastPercent = 0
let progressIndeterminate = true
let slowAfterMs = 80000

function renderProgress(progress) {
  if (!progress || typeof progress.percent !== 'number') return
  // 慢机器阈值由主进程按性能档位给出（低配机器启动本来就慢，不能用同一个阈值误报）。
  if (typeof progress.slowAfterMs === 'number' && progress.slowAfterMs > 0) slowAfterMs = progress.slowAfterMs
  const percent = Math.max(lastPercent, Math.min(100, Math.round(progress.percent)))
  lastPercent = percent
  progressIndeterminate = progress.indeterminate === true
  const wrap = document.querySelector('[data-role="progress"]')
  const bar = document.querySelector('[data-role="progressbar"]')
  const fill = document.querySelector('[data-role="progress-fill"]')
  if (wrap) wrap.setAttribute('data-mode', progressIndeterminate ? 'indeterminate' : 'determinate')
  // 填充长度永远等于真实进度（不确定态只额外叠一条扫光），百分比文字也永远显示真实值：
  // 让"6%"配一条满格进度条是最容易骗到自己人的写法。
  if (fill) fill.style.width = percent + '%'
  if (bar) {
    bar.setAttribute('aria-valuenow', String(percent))
    bar.setAttribute('aria-busy', progressIndeterminate ? 'true' : 'false')
    const text = [progress.label, progress.detail].filter(Boolean).join('，')
    if (text !== '') bar.setAttribute('aria-valuetext', text)
  }
  if (progress.label) setText('progress-stage', progress.label)
  setText('progress-percent', percent + '%')
  setText('progress-detail', progress.detail || '')
}

/** 已用时秒表：低配机器上「等了多久」比百分比更能说明问题，如实显示。 */
function startElapsed(startedAt) {
  const begin = typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now()
  const tick = () => {
    const seconds = Math.max(0, Math.round((Date.now() - begin) / 1000))
    setText('elapsed', seconds < 3 ? '' : '已用时 ' + seconds + ' 秒')
  }
  tick()
  setInterval(tick, 1000)
}

/** 降载说明：只在本机真的被降载时出现（低配档 / 显卡加速被关闭），不是装饰文案。 */
function renderPerf(perf) {
  if (!perf) return
  const notes = []
  if (perf.tier === 'low') {
    const reasons = Array.isArray(perf.reasons) && perf.reasons.length > 0 ? perf.reasons.join('、') : '本机配置较低'
    notes.push('低配模式：' + reasons + '，已自动降低启动与后台资源占用')
  }
  if (perf.gpuSoftware === true) {
    notes.push('显卡加速已关闭：' + (perf.gpuReason || '本机显卡加速不稳定'))
  }
  if (notes.length === 0) return
  setText('tier', notes.join('；'))
  setOpen('tier', true)
}

/** 启动失败时把原因摊开给用户，并给出"重试启动 / 完全退出"两条路。 */
function renderKernel(status) {
  if (!status) return
  if (status.progress) renderProgress(status.progress)
  if (status.perf) renderPerf(status.perf)
  if (status.error) {
    const problem = document.querySelector('[data-role="problem"]')
    if (problem) problem.textContent = status.error
    setOpen('problem', true)
    setOpen('actions', true)
    setText('hint', '启动失败，可以重试；若一直失败请选择"完全退出"后重新打开。')
    return
  }
  if (status.attached) {
    setOpen('problem', false)
    setOpen('actions', false)
    setText('hint', status.attached)
    return
  }
  setOpen('problem', false)
  setOpen('actions', false)
  if (status.handshake && status.handshake.serverInfo) {
    setText('hint', '正在打开工作台…')
  }
}

async function refreshKernel() {
  try {
    renderKernel(await window.bosomKernel.getStatus())
  }
  catch {
    // 桥未就绪时保持原文案
  }
}

if (window.bosomFriend) {
  window.bosomFriend.getStatus().then((status) => {
    setText('version', 'v' + status.version)
    startElapsed(status.startedAt)
  }).catch(() => { startElapsed(0) })
  const quit = document.querySelector('[data-role="quit"]')
  if (quit) quit.addEventListener('click', () => { void window.bosomFriend.quit() })
}
else {
  startElapsed(0)
}

if (window.bosomKernel) {
  window.bosomKernel.onHandshake(renderKernel)
  window.bosomKernel.onProgress(renderProgress)
  window.bosomKernel.onEvent(() => {})
  refreshKernel()
  setInterval(refreshKernel, 1500)
  const retry = document.querySelector('[data-role="retry"]')
  if (retry) {
    retry.addEventListener('click', async () => {
      retry.disabled = true
      setText('hint', '正在重试启动…')
      try {
        renderKernel(await window.bosomKernel.retry())
      }
      catch {
        setText('hint', '重试失败，请选择"完全退出"后重新打开。')
      }
      retry.disabled = false
    })
  }
}

// 品牌启动页：产品就绪后由主进程直接切换页面；超时只给友好提示，不显示技术细节。
// 低配机器（机械盘 / 小内存）启动本来就慢，阈值由主进程按档位给出，避免对慢机器误报。
const startedAt = Date.now()
setInterval(() => {
  const problem = document.querySelector('[data-role="problem"]')
  const hasProblem = problem && problem.getAttribute('data-open') === 'true'
  if (!hasProblem && Date.now() - startedAt > slowAfterMs && !progressIndeterminate) {
    setText('hint', '启动时间较长，请再稍等；如长时间无响应，请在托盘菜单选择"完全退出"后重新打开')
  }
}, 5000)
