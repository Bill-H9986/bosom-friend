// 恢复 2026-08-30 真实发布的小红书笔记记录与指标（账号换新会话后重新归属），
// 需在服务停止后运行，避免内存缓存覆盖磁盘文件。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(homedir(), '.bosom-friend', 'bosom-friend')
const cover = 'cover-3v3swvh5.png'
if (!existsSync(join(dir, 'uploads', cover))) {
  console.error('cover missing')
  process.exit(2)
}

const accounts = JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8'))
const xhs = accounts.find(a => a.type === 'xhs')
if (!xhs) {
  console.error('no xhs account')
  process.exit(3)
}

const record = {
  id: 'rec-jh8m44r5',
  flowId: 'flow-welhlbbp',
  taskId: 'rec-jh8m44r5',
  userId: 'zy-user-001',
  accountId: xhs.id,
  accountType: 'xhs',
  type: 'ImageText',
  status: 1,
  title: '重庆飞北京被气流颠成筛子？机长说这很正常',
  desc: '刚才落地时，不少小伙伴估计被晃得有点懵吧？😂 作为飞了十年的老机长，今天必须得跟大家说句掏心窝的话：\n\n'
    + '第一，**别怕，那是正常的**。遇到强气流（Turbulence）就像开车走烂路一样，飞机只是稍微抖了一下，绝对安全！✈️ 现代客机的结构强度远超你想的，这点颠簸连“小插曲”都算不上。\n\n'
    + '第二，**请系好安全带**！这是保护你自己的最好方式。哪怕你坐在座位上，也别为了显摆或嫌麻烦而解开它。在平飞阶段，突发颠簸往往就在几秒钟内，系好带子能让你瞬间稳住，避免撞到头或摔出来。🙅‍♂️\n\n'
    + '第三，**听指挥，别慌**。如果看到乘务员赶紧坐下系好安全带，请立刻配合！不要坚持站着倒水或拿行李，那是在拿自己的安全开玩笑。🛑\n\n'
    + '我是重庆崽儿，飞了这么多年，见过的旅客比天上的云还多。每一次平稳降落，看到大家安安心心走出舱门，就是我最大的成就感！☁️\n\n'
    + '最后，下次坐飞机，记得：心慌没关系，但安全带一定要系紧哦！爱你们～❤️',
  publishTime: '2026-08-30T17:23:29.325Z',
  videoUrl: '',
  coverUrl: '/bosom-friend/api/assets/file/' + cover,
  imgUrlList: ['/bosom-friend/api/assets/file/' + cover],
  topics: ['重庆', '飞行员', '飞行日常', '安全出行'],
  source: 'publish',
  errorMsg: '',
  createdAt: '2026-08-30T17:23:29.325Z',
  updatedAt: '2026-08-30T17:24:21.498Z',
  linkStatus: 'ready',
  engagement: { viewCount: 0, commentCount: 0, likeCount: 0, shareCount: 0, clickCount: 0, impressionCount: 0, favoriteCount: 0 },
  platformWorkId: '',
  workLink: '',
  publishedAt: '2026-08-30T17:24:21.498Z',
}
writeFileSync(join(dir, 'publish-records.json'), JSON.stringify([record], null, 2), 'utf8')

writeFileSync(join(dir, 'metrics.json'), JSON.stringify([{
  date: '2026-08-30',
  platform: 'xhs',
  accountId: xhs.id,
  workId: 'rec-jh8m44r5',
  viewCount: 0,
  likeCount: 0,
  commentCount: 0,
  shareCount: 0,
  favoriteCount: 0,
}], null, 2), 'utf8')

xhs.workCount = 1
xhs.updateTime = new Date().toISOString()
writeFileSync(join(dir, 'accounts.json'), JSON.stringify(accounts, null, 2), 'utf8')
console.log('restored under account', xhs.id, xhs.nickname)
