/*
 * @Author: nevin
 * @Date: 2025-01-17 19:25:29
 * @LastEditTime: 2025-02-27 16:41:49
 * @LastEditors: nevin
 * @Description:
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';
import pkg from './package.json';
import webPkg from '../bosom-friend-web/package.json';
import svgr from "vite-plugin-svgr";
import { createSvgIconsPlugin } from "vite-plugin-svg-icons";
import tailwindcss from "@tailwindcss/vite";

/** Web 源码包的静态资源（提示词视频/封面）不属于 Electron 项目 public，构建时合并到本地 public。 */
function syncWebPublic(): void {
  const source = path.join(__dirname, '../bosom-friend-web/public');
  const target = path.join(__dirname, 'public');
  if (!existsSync(source))
    return;
  cpSync(source, target, { recursive: true, force: true });
}

syncWebPublic();

// https://vitejs.dev/config/
export default defineConfig(({ command }) => {
  // 沙箱环境（WorkBuddy）会拦截 node 内 rmSync/trash；忽略清理失败（旧产物可被覆盖）
  try {
    rmSync('dist-electron', { recursive: true, force: true });
  }
  catch {
    // 清理失败不阻断启动
  }

  const isServe = command === 'serve';
  const isBuild = command === 'build';
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG;

  return {
    base: '/bosom-friend/',
    define: {
      __WEB_BUILD_VERSION__: JSON.stringify('v' + webPkg.version),
      'process.env.NODE_ENV': JSON.stringify(isServe ? 'development' : 'production'),
      'process.env.NEXT_PUBLIC_API_URL': JSON.stringify('/bosom-friend/api'),
      'process.env.NEXT_PUBLIC_HOST_URL': JSON.stringify('https://bosomfriend.local'),
      'process.env.NEXT_PUBLIC_ABROAD_DOMAIN': JSON.stringify('https://bosomfriend.local/'),
      'process.env.NEXT_PUBLIC_CHINA_DOMAIN': JSON.stringify('https://bosomfriend.local/'),
      'process.env.NEXT_PUBLIC_REGION': JSON.stringify('Domestic'),
      'process.env.NEXT_PUBLIC_EVN': JSON.stringify('dev'),
      'process.env.NEXT_PUBLIC_OSS_URL': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_OSS_URL_PROXY': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_OSS_TEMP_URL': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_OSS_IMAGE_THUMBNAIL_MAX_WIDTH': JSON.stringify(''),
      'process.env.NEXT_PUBLIC_ENABLE_OSS_IMAGE_THUMBNAIL': JSON.stringify('false'),
      'process.env.BOSOM_FRIEND_UPDATE_URL': JSON.stringify(process.env.BOSOM_FRIEND_UPDATE_URL || ''),
    },
    resolve: {
      alias: {
        '@': path.join(__dirname, 'src'),
        '@web': path.join(__dirname, '../bosom-friend-web/src'),
        '@@': path.join(__dirname, 'commont'),
        '@kwooshung/react-no-ssr': path.join(__dirname, 'node_modules/@kwooshung/react-no-ssr/dist/react-no-ssr.es.js'),
        buffer: 'buffer',
      },
    },
    css: {
      preprocessorOptions: {
        scss: {
          api: 'modern-compiler',
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            // react/react-dom/router 与 antd 存在环形引用：拆到独立 chunk 会导致
            // 生产构建下 React 在 antd 初始化时仍为 undefined（读 React.version 崩溃）。
            // 全部并入同一 chunk，消除跨 chunk 循环。
            if (/node_modules[\\/](antd|@ant-design|rc-|react|react-dom|react-router|react-router-dom|scheduler)/.test(id)) return 'vendor-ui';
            if (/node_modules[\\/](echarts|zrender)/.test(id)) return 'vendor-charts';
            if (/node_modules[\\/](framer-motion|motion)/.test(id)) return 'vendor-motion';
            if (/node_modules[\\/](@lexical|lexical)/.test(id)) return 'vendor-editor';
            if (/node_modules[\\/](lodash|dayjs|moment)/.test(id)) return 'vendor-utils';
            return undefined;
          },
        },
      },
    },
    plugins: [
      react(),
      tailwindcss(),
      // 桌面端现用 products/bosom-friend/desktop/electron/main.cjs + kernel-host.cjs（官方 DSH 内核宿主），
      // 不再是本项目的 electron/main/index.ts（旧知音 zhiyin harness，已淘汰，其依赖 bosom-friend-harness 已删）。
      // 因此只构建 renderer（产物 dist/），不构建旧的 main/preload，避免引用已淘汰模块导致整包构建失败。
      svgr({ svgrOptions: { icon: true } }),
      createSvgIconsPlugin({
        iconDirs: [path.resolve(process.cwd(), "src/assets/svgs")],
      })
    ],
    server: {
      // Web 主界面源码包位于 ../bosom-friend-web（electron 项目根目录之外）。
      // 必须加入 fs.allow 白名单，否则其静态资源（设计字体/图片）经 /@fs/ 服务一律 403，
      // 字体回退系统字体、图片缺失，导致全局排版观感被打乱。
      fs: {
        allow: [
          __dirname,
          path.join(__dirname, '../bosom-friend-web'),
        ],
      },
      ...(process.env.VSCODE_DEBUG
        ? (() => {
            const url = new URL(pkg.debug.env.VITE_DEV_SERVER_URL);
            return {
              host: url.hostname,
              port: +url.port,
            };
          })()
        : {}),
    },
    clearScreen: false,
  };
});
