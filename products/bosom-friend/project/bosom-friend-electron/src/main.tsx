import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ConfigProvider } from 'antd';
import zh_CN from 'antd/es/locale/zh_CN';
import 'virtual:svg-icons-register';

import './index.scss';
import './var.css';
import '@web/app/globals.css';

import { generate } from '@ant-design/colors';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <>
    {(() => {
// Bosom Friend AI 主题色：淡紫相邻色系（紫罗兰专业感）
const colors = generate('#8B7CF6');
      const root = document.documentElement;
      // 性能档位由服务端注入（桌面壳探测 → 内核子进程环境变量 → index.html 注入）。
      // 低配档位只关重特效，不改任何功能与信息展示。
      const perfTier = (window as { __BF_PERF_TIER__?: string }).__BF_PERF_TIER__;
      if (perfTier === 'low') root.dataset.perf = 'low';
      for (let i = 0; i < colors.length; i++) {
        /**
         * 主题色：
         * --colorPrimary1  ~~  --colorPrimary10
         * 由浅到深
         * 注意：“--colorPrimary6” 为中间主题色，不是 “5”
         */
        root.style.setProperty(`--colorPrimary${i + 1}`, colors[i]);
      }

      return (
        <ConfigProvider
          locale={zh_CN}
          theme={{
            token: {
              colorPrimary: colors[5].trim(),
              colorSuccess: '#34c759',
              colorWarning: '#ff9500',
              colorError: '#ff3b30',
              colorInfo: colors[5].trim(),
              colorTextBase: '#0a0a0a',
              colorText: '#0a0a0a',
              colorTextSecondary: '#6b7280',
              colorTextTertiary: '#94a3b8',
              colorBorder: '#e5e5e5',
              colorBorderSecondary: '#f0f0f0',
              colorBgLayout: '#ffffff',
              colorBgContainer: '#ffffff',
              colorBgElevated: '#ffffff',
              borderRadius: 10,
              borderRadiusLG: 18,
              borderRadiusSM: 8,
              controlHeight: 36,
              controlHeightLG: 44,
              fontSize: 14,
              fontFamily:
                "Suisseintl, 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
              boxShadow:
                '0 1px 2px rgba(169,137,255,0.06), 0 4px 16px rgba(169,137,255,0.10)',
              boxShadowSecondary:
                '0 8px 30px rgba(169,137,255,0.14)',
              wireframe: false,
            },
            components: {
              Button: {
                controlHeight: 36,
                borderRadius: 9999,
                fontWeight: 500,
                primaryShadow: '0 4px 14px rgba(169, 137, 255, 0.30)',
                defaultShadow: 'none',
              },
              Card: {
                borderRadiusLG: 18,
                headerFontSize: 16,
                headerHeight: 52,
                paddingLG: 24,
                boxShadowTertiary:
                  '0 1px 2px rgba(169,137,255,0.06), 0 8px 24px rgba(169,137,255,0.10)',
              },
              Table: {
                headerBg: '#f7f7f7',
                headerColor: '#6b7280',
                headerSplitColor: 'transparent',
                rowHoverBg: '#faf7ff',
                cellPaddingBlock: 13,
                cellPaddingInline: 16,
                borderRadius: 12,
              },
              Modal: {
                borderRadiusLG: 18,
                titleFontSize: 17,
              },
              Input: {
                controlHeight: 36,
                borderRadius: 10,
                activeShadow: '0 0 0 3px rgba(169, 137, 255, 0.14)',
              },
              InputNumber: {
                controlHeight: 36,
                borderRadius: 10,
              },
              Select: {
                controlHeight: 36,
                borderRadius: 10,
                optionSelectedBg: 'rgba(169, 137, 255, 0.10)',
              },
              Tabs: {
                titleFontSize: 14,
                itemSelectedColor: colors[5].trim(),
                inkBarColor: colors[5].trim(),
              },
              Tag: {
                borderRadiusSM: 6,
              },
              Menu: {
                itemBorderRadius: 10,
                itemSelectedBg: 'rgba(169, 137, 255, 0.10)',
  itemSelectedColor: '#8b7cf6',
              },
              Dropdown: {
                borderRadiusLG: 12,
              },
              Popover: {
                borderRadiusLG: 14,
              },
              Tooltip: {
                borderRadius: 8,
              },
              Drawer: {
                borderRadiusLG: 16,
              },
            },
          }}
        >
          <App />
        </ConfigProvider>
      );
    })()}
  </>,
);

postMessage({ payload: 'removeLoading' }, '*');
