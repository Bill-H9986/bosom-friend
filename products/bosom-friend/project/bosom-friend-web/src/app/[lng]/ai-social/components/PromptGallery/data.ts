/**
 * PromptGallery 静态资源数据
 * 功能：提供视频提示词画廊的封面图片和视频资源路径
 * 注意：提示词内容通过国际化翻译文件加载（promptGallery.json）
 */

/** 提示词画廊静态资源配置 */
export const promptGalleryAssets = [
  {
    title: '金丝雀码头探店打卡视频',
    cover: './assets/promptGallery/cover01.png',
    video: './assets/promptGallery/video01.mp4',
    materials: ['./assets/promptGallery/material01-1.png', './assets/promptGallery/material01-2.png'],
    prompt: `制作一条竖屏短视频（9:16，时长 15 秒），现代金丝雀码头高档餐厅探店打卡：开场博主走进餐厅大门，穿过精致用餐区，餐桌摆盘考究的菜品特写，暖色灯光，手持跟拍运镜，节奏舒缓，真实美食探店视频质感。`,
  },
  {
    title: '餐厅探店短视频',
    cover: './assets/promptGallery/cover02.png',
    video: './assets/promptGallery/video02.mp4',
    materials: ['./assets/promptGallery/material02-1.png', './assets/promptGallery/material02-2.png'],
    prompt: `制作一条竖屏短视频（9:16，时长 15 秒），餐厅探店短视频：开场店外街景，博主推开餐厅门走进店内，餐厅内部环境全景，刚上桌的招牌菜品特写，电影感运镜，节奏舒缓，真实探店记录质感。`,
  },
  {
    title: '老洋房英式餐厅宣传片',
    cover: './assets/promptGallery/cover03.png',
    video: './assets/promptGallery/video03.mp4',
    materials: ['./assets/promptGallery/material03-1.png', './assets/promptGallery/material03-2.png'],
    prompt: `制作一条竖屏短视频（9:16，时长 15 秒），老洋房英式餐厅宣传片：开场老洋房建筑外观，复古英式餐厅内部环境，精致的英式菜肴与炸鱼薯条特写，暖色调灯光，节奏舒缓，高级宣传片质感。`,
  },
]
