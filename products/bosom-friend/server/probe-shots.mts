import { parseShotPlan, fallbackShotPlan } from './src/storyboard.ts'
const raw = JSON.stringify({ continuity: 'x', shots: [
  { kind: 'talking-head', seconds: 6, line: '姐妹们，秋冬脸干到起皮，化妆卡粉特别明显。', beat: 'hook' },
  { kind: 'product', seconds: 5, visual: '产品特写' },
] })
const shots = parseShotPlan(raw, [{ url: 'a', role: 'person' }], 'digital-human')
console.log('parseShotPlan =>', JSON.stringify(shots.map(s => ({ kind: s.kind, seconds: s.seconds, t: typeof s.seconds }))))
const fb = fallbackShotPlan(['第一句口播内容。', '第二句口播内容。'], [], 'scene', false)
console.log('fallbackShotPlan =>', JSON.stringify(fb.map(s => ({ kind: s.kind, seconds: s.seconds, t: typeof s.seconds }))))
