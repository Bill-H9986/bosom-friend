import { readFileSync } from 'node:fs';
const items = [
['app/[lng]/accounts/components/AccountsTopNav/components/AccountSelector.tsx',76],['app/[lng]/accounts/components/CalendarTiming/CalendarHolidayBadge/index.tsx',153],['app/[lng]/accounts/components/CalendarTiming/MobileCalendar/MobileCalendarHeader.tsx',78],['app/[lng]/accounts/components/CalendarTimingItem/components/RecordCore.tsx',903],['app/[lng]/accounts/components/CalendarTimingItem/components/ScrollButtonContainer/index.tsx',120],['app/[lng]/hot-content/components/HotContentNavigation.tsx',56],['components/Chat/Share/ShareModal.tsx',592],['components/draft-box/components/AiBatchGenerateBar/components/CaptionPromptField/index.tsx',35],['components/draft-box/components/AiBatchGenerateBar/components/ImageStack/components/DesktopImageStack/index.tsx',68],['components/draft-box/components/AiBatchGenerateBar/components/PlatformLimitsInfo/index.tsx',55],['components/Plugin/PluginReady/AccountsTab.tsx',453],['components/Plugin/PluginReady/index.tsx',87],['components/PublishDialog/compoents/DesktopPublishContent/index.tsx',458],['components/PublishDialog/compoents/PubParmasTextarea/VideoCoverSeting.tsx',314],['components/ui/date-picker/index.tsx',107],['components/ui/card.tsx',4]
];
const W = 'C:/Users/Jay/Desktop/Bosom friend APP/apps/bosom-friend/project/bosom-friend-web/src/';
for (const [rel, ln] of items) {
  const lines = readFileSync(W + rel, 'utf8').split('\n');
  console.log('--- ' + rel + ':' + ln + ' ---');
  for (let i = Math.max(0, ln - 4); i < Math.min(lines.length, ln + 3); i++) console.log((i + 1) + '| ' + lines[i]);
}