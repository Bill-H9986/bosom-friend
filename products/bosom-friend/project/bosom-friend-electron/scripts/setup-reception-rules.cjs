const TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNzkzZGE4MWYwYmZhYjhhZDVkMDY0OCIsIm1haWwiOiJhZG1pbkBhaXRvZWFybi5sb2NhbCIsIm5hbWUiOiJBZG1pbiIsImlhdCI6MTc4NjMzMDUzNiwiZXhwIjo0OTQyMDkwNTM2fQ.QUQqQ7xI935ZWF6GE6RBaNJoKUVz1S1gW1WPZCLbc1s';
const BASE = 'http://127.0.0.1:8080/api/v2/customer-reception';

async function api(path, method, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

(async () => {
  const { json } = await api('/rules', 'GET');
  const rules = json.data || [];
  console.log('现有规则', rules.length);
  for (const r of rules) {
    const isBad = /[\uFFFD?]/.test(r.name) || !/[\u4e00-\u9fa5]/.test(r.name);
    if (isBad) {
      await api('/rules/' + r.id, 'DELETE');
      console.log('已删除损坏规则', r.id, r.name);
    }
  }

  const newRules = [
    {
      name: '教程咨询',
      keywords: ['视频怎么做', '怎么做', '教程', '想学', '教教我', '怎么弄', '如何做'],
      platforms: [],
      replyMode: 'ai',
      aiModel: 'agnes-2.5-flash',
      systemPrompt:
        '你是「知音AI内容营销系统」的智能客服助手，访客在问视频/内容是怎么做出来的，请热情介绍知音的一站式AI内容创作能力（AI写脚本、AI生成视频、一键多平台发布、7×24自动接待），并引导对方留下需求。用简洁、热情、专业的中文回复。',
      enabled: true,
      priority: 80,
    },
    {
      name: '合作洽谈',
      keywords: ['合作', '商务', '推广', '投放', '广告'],
      platforms: [],
      replyMode: 'ai',
      aiModel: 'agnes-2.5-flash',
      systemPrompt:
        '你是「知音AI内容营销系统」的商务对接助手，访客想洽谈合作，请表示欢迎并说明可以私信留下联系方式，稍后专人对接。用简洁、专业的中文回复。',
      enabled: true,
      priority: 70,
    },
  ];

  for (const rule of newRules) {
    const r = await api('/rules', 'POST', rule);
    console.log('创建规则', rule.name, r.status, JSON.stringify(r.json).slice(0, 100));
  }
})();
