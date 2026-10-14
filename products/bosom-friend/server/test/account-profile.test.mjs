/**
 * 账号资料回写单测：登录补传与平台同步共用同一条回写规则 —— 只覆盖确实采集到的字段。
 * 运行：node --import tsx/esm products/bosom-friend/server/test/account-profile.test.mjs
 */
import assert from 'node:assert/strict'
import { applyAccountProfile } from '../src/platform-login.ts'

const base = () => ({
  id: 'acc-test',
  type: 'xhs',
  uid: '18952484713',
  nickname: '小红书',
  avatar: 'https://img.xiaohongshu.com/old.jpg',
  fansCount: 0,
  followingCount: 0,
  workCount: 0,
  income: 0,
  status: 1,
  rank: 0,
  groupId: 'grp-default',
  clientType: 'web',
  createTime: '2026-09-09T00:00:00.000Z',
  updateTime: '2026-09-09T00:00:00.000Z',
})

// 1. 同步路径：只带粉丝数，不碰昵称/头像
const synced = base()
applyAccountProfile(synced, 'xhs', { fansCount: 7 })
assert.equal(synced.fansCount, 7)
assert.equal(synced.nickname, '小红书')
assert.equal(synced.avatar, 'https://img.xiaohongshu.com/old.jpg')

// 2. 登录补传路径：昵称/头像/粉丝数一起回写，昵称走占位值兜底
const enriched = base()
applyAccountProfile(enriched, 'xhs', {
  nickname: 'No name',
  avatar: 'https://img.xiaohongshu.com/new.jpg',
  fansCount: 7,
})
assert.equal(enriched.nickname, '小红书')
assert.equal(enriched.avatar, 'https://img.xiaohongshu.com/new.jpg')
assert.equal(enriched.fansCount, 7)

// 3. 空更新不覆盖现值（worker 未采到资料时）
const untouched = base()
untouched.fansCount = 36
applyAccountProfile(untouched, 'xhs', {})
assert.equal(untouched.fansCount, 36)
assert.equal(untouched.nickname, '小红书')

// 4. 非法粉丝数被忽略，不把真实值写成 NaN
const guarded = base()
guarded.fansCount = 36
applyAccountProfile(guarded, 'xhs', { fansCount: Number.NaN })
assert.equal(guarded.fansCount, 36)

// 5. 空头像不覆盖已有头像
const keepAvatar = base()
applyAccountProfile(keepAvatar, 'xhs', { avatar: '' })
assert.equal(keepAvatar.avatar, 'https://img.xiaohongshu.com/old.jpg')

console.log('ACCOUNT_PROFILE_OK')
