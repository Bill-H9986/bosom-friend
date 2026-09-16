# 缺陷：图片 `imageSize` 未传给后端，导致成品比例/分辨率错误

## 现象

在内容创作页面选择比例和图片档位后，生成记录里 `request.resolution` 为空，
图片模型返回的原始图为正方形，前端页面看起来所有比例都是正方形。

## 根因

前端 `CreateMaterialModal`/`planDetailStore` 的请求字段叫 `imageSize`，
后端 `createDraftGeneration` 只读取 `resolution`，没有读取 `imageSize`。

## 证据

诊断请求：

```json
{ "aspectRatio": "3:4", "imageSize": "720p" }
```

修复前的任务记录：

```json
{ "resolution": "", "aspectRatio": "3:4" }
```

修复后的任务记录与成品：

```json
{ "resolution": "720p", "aspectRatio": "3:4", "imageCount": 1 }
```

`ai-img-0f0c47dd.png` 实测尺寸为 `720x960`，符合 3:4。

## 修复

`products/bosom-friend/server/src/api.ts`：

1. `resolution` 回退读取 `imageSize`；
2. 请求记录增加 `imageCount`；
3. `attachGenerationMedia` 按 `imageCount` 生成图片，不再固定 2 张；
4. 同步到内核运行时（`kernel-runtime-unpacked`、`kernel-runtime-extras`、`kernel-runtime.zip`）。

交付版本：`0.2.28`。

## 验证

直连接口诊断成功：`status=success`、`generatedImageCount=1`、图片尺寸 `720x960`；
前端内容创作 worker 首次完整提交成功并被页面识别。
