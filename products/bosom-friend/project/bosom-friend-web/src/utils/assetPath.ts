/**
 * 桌面端静态资源绝对化：
 *
 * 打包版以 file:// 加载，且路由会把 document.pathname 改写成 /draft-box 等路径，
 * 相对资源（./assets/...）会解析到错误位置。这里在运行时从已加载的 JS 资源地址
 * 反推出 dist 目录的真实基址，把资源路径解析成绝对 file:// URL，保证任何页面都能加载。
 */
let cachedBase: string | null = null;

function computeBase(): string {
  if (cachedBase)
    return cachedBase;
  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const hit = entries.find((e) => /\/assets\/[^/]+\.(?:js|css)$/.test(e.name));
    if (hit) {
      const url = new URL(hit.name, window.location.href);
      const segments = url.pathname.split('/');
      const assetsIndex = segments.lastIndexOf('assets');
      if (assetsIndex > 0) {
        segments.length = assetsIndex;
        cachedBase = `${url.protocol}//${url.host}${segments.join('/')}/`;
        return cachedBase;
      }
    }
  }
  catch {
    // 兜底使用当前地址
  }
  cachedBase = window.location.href;
  return cachedBase;
}

/** 把静态资源路径解析为绝对地址（http/data/blob/file 开头则原样返回） */
export function resolveAsset(path?: string): string {
  if (!path || /^(https?:|data:|blob:|file:)/i.test(path))
    return path ?? '';
  // 根绝对路径（如 Vite 产出的 /bosom-friend/assets/logo.png）本身已含部署基址，
  // 只能相对站点根解析；若再拼一次 dist 基址会变成 /bosom-friend/bosom-friend/...，
  // 图片加载失败后浏览器会渲染 alt 文本（平台图标一列竖排即由此而来）。
  if (path.startsWith('/')) {
    try {
      return new URL(path, window.location.origin).toString();
    }
    catch {
      return path;
    }
  }
  const cleaned = path.replace(/^\.?\/+/, '');
  try {
    return new URL(cleaned, computeBase()).toString();
  }
  catch {
    return path;
  }
}
