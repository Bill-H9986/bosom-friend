#!/usr/bin/env node
/**
 * 一次性恢复：把被清空的模型配置按 DSH 投影与凭据文件还原。
 * 数据来源：~/.dsh/settings.yaml（提供方/地址/模型）+ ~/.dsh/.credentials.yaml（密钥）
 *          + 现存 llm-user.json 里未丢的图片/视频模型。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH = join(homedir(), '.dsh')
const settings = readFileSync(join(DSH, 'settings.yaml'), 'utf8')
const credentials = readFileSync(join(DSH, '.credentials.yaml'), 'utf8')
const apiKey = (credentials.match(/AGNES_API_KEY:\s*(\S+)/) ?? [])[1] ?? ''
// 投影是 flow 风格 YAML，值后面跟着逗号：不能把逗号吃进地址。
const baseUrl = ((settings.match(/baseURL:\s*([^,\s]+)/) ?? [])[1] ?? '').replace(/[,\s]+$/, '')
const models = [...settings.matchAll(/id:\s*([A-Za-z0-9._-]+)/g)].map(m => m[1])
const current = JSON.parse(readFileSync(join(homedir(), '.bosom-friend', 'bosom-friend', 'llm-user.json'), 'utf8'))

const chatModel = models[0] ?? 'agnes-2.5-flash'
const imageModel = current.imageModel ?? ''
const videoModel = current.videoModel ?? ''
const all = [...new Set([chatModel, imageModel, videoModel].filter(Boolean))]

const payload = {
  providers: [{
    id: 'agnes',
    displayName: 'Agnes AI',
    baseUrl,
    protocol: 'openai-completions',
    apiKey,
    models: all,
    modelLabels: {},
    modelOptions: {
      ...(imageModel ? { [imageModel]: { kind: 'image' } } : {}),
      ...(videoModel ? { [videoModel]: { kind: 'video' } } : {}),
    },
  }],
  activeProviderId: 'agnes',
  image: imageModel ? { providerId: 'agnes', model: imageModel } : { model: '' },
  video: videoModel ? { providerId: 'agnes', model: videoModel } : { model: '' },
}
console.log('RESTORE_PAYLOAD ' + JSON.stringify({ ...payload, providers: payload.providers.map(p => ({ ...p, apiKey: p.apiKey.slice(0, 8) + '...' })) }))

const res = await fetch('http://127.0.0.1:31280/bosom-friend/api/ai/user-llm', {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: 'Bearer bf-local-guest-token' },
  body: JSON.stringify(payload),
})
console.log('PUT ' + res.status + ' ' + (await res.text()).slice(0, 200))
