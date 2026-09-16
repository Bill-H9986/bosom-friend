const TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhNzkzZGE4MWYwYmZhYjhhZDVkMDY0OCIsIm1haWwiOiJhZG1pbkBhaXRvZWFybi5sb2NhbCIsIm5hbWUiOiJBZG1pbiIsImlhdCI6MTc4NjMzMDUzNiwiZXhwIjo0OTQyMDkwNTM2fQ.QUQqQ7xI935ZWF6GE6RBaNJoKUVz1S1gW1WPZCLbc1s';

(async () => {
  for (const message of ['这个视频怎么做出来的？教教我吧', '你们怎么收费的？']) {
    const res = await fetch('http://127.0.0.1:8080/api/v2/customer-reception/handle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ message, platform: 'douyin', source: 'dm' }),
    });
    console.log('=== ' + message);
    console.log((await res.text()).slice(0, 500));
  }
})();
