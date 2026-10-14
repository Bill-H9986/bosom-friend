/**
 * 瀑布流断点配置
 * 按屏幕宽度分列，供各内容列表共用；容器宽度驱动的分列见 useContainerMasonryColumns
 */

export const MASONRY_BREAKPOINTS = {
  default: 5, // > 1280px
  1280: 4, // <= 1280px
  1024: 3, // <= 1024px
  768: 3, // <= 768px
  640: 2, // <= 640px
}
