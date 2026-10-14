const fs = require('fs');

// ---------- protobuf helpers ----------
function writeVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (true) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if (v === 0n) {
      out.push(b);
      break;
    }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, pos };
}

function encodeString(fn, s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarint((BigInt(fn) << 3n) | 2n), writeVarint(b.length), b]);
}

function encodeVarintField(fn, v) {
  return Buffer.concat([writeVarint((BigInt(fn) << 3n) | 0n), writeVarint(BigInt(v))]);
}

function encodeBytes(fn, buf) {
  return Buffer.concat([writeVarint((BigInt(fn) << 3n) | 2n), writeVarint(buf.length), buf]);
}

function buildRequest(convId, cursor, timestamp) {
  const inner = Buffer.concat([
    encodeString(1, convId),
    encodeVarintField(2, 1),
    encodeVarintField(3, BigInt(cursor)),
    encodeVarintField(4, 1),
    encodeVarintField(5, BigInt(timestamp)),
    encodeVarintField(6, 50),
  ]);
  const queryMsg = encodeBytes(301, inner);
  return Buffer.concat([
    encodeVarintField(1, 301),
    encodeVarintField(2, 10027),
    encodeString(3, '0.1.6'),
    encodeString(4, ''),
    encodeVarintField(5, 3),
    encodeVarintField(6, 0),
    encodeString(7, 'fef1a80:p/lzg/store'),
    encodeBytes(8, queryMsg),
    encodeString(9, '0'),
    encodeString(11, 'douyin_pc'),
    encodeString(14, '360000'),
    encodeVarintField(18, 1),
    encodeString(21, 'douyin_pc'),
  ]);
}

function extractField(buf, target) {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const fn = Number(tag.value >> 3n);
    const wt = Number(tag.value & 7n);
    if (wt === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
    } else if (wt === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const l = Number(len.value);
      const slice = buf.subarray(pos, pos + l);
      if (fn === target) return slice;
      pos += l;
    } else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else break;
  }
  return null;
}

function parseMessage(buf) {
  const r = {};
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const fn = Number(tag.value >> 3n);
    const wt = Number(tag.value & 7n);
    if (fn === 0 || fn > 500) break;
    if (wt === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      if (fn === 3) r.server_id = v.value.toString();
      else if (fn === 4) r.created_at_us = v.value.toString();
      else if (fn === 5) r.order = v.value.toString();
      else if (fn === 7) r.sender_uid = v.value.toString();
      else if (fn === 6) r.type_code = Number(v.value);
      else if (fn === 11) r.is_recalled = Number(v.value);
      else if (fn === 12) r.visible = Number(v.value);
    } else if (wt === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const l = Number(len.value);
      const slice = buf.subarray(pos, pos + l);
      if (fn === 1) r.conv_id = slice.toString('utf8');
      else if (fn === 8) {
        try { r.content_json = slice.toString('utf8'); } catch {}
      } else if (fn === 14) {
        try { r.sender_sec_uid = slice.toString('utf8'); } catch {}
      }
      pos += l;
    } else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else break;
  }
  return r;
}

function parseResponse(data) {
  const f6 = extractField(data, 6);
  if (!f6) return { msgs: [], hasMore: 0, nextTs: null };
  const f301 = extractField(f6, 301);
  if (!f301) return { msgs: [], hasMore: 0, nextTs: null };
  let pos = 0;
  const msgs = [];
  let nextTs = null;
  let hasMore = 0;
  while (pos < f301.length) {
    const tag = readVarint(f301, pos);
    pos = tag.pos;
    const fn = Number(tag.value >> 3n);
    const wt = Number(tag.value & 7n);
    if (wt === 0) {
      const v = readVarint(f301, pos);
      pos = v.pos;
      if (fn === 2) nextTs = v.value.toString();
      if (fn === 3) hasMore = Number(v.value);
    } else if (wt === 2) {
      const len = readVarint(f301, pos);
      pos = len.pos;
      const l = Number(len.value);
      if (fn === 1) msgs.push(parseMessage(f301.subarray(pos, pos + l)));
      pos += l;
    } else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else break;
  }
  return { msgs, nextTs, hasMore };
}

// ---------- main ----------
(async () => {
  const cookieStr = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/douyin-cookie.txt', 'utf8').trim();
  const sessionid = (cookieStr.match(/sessionid=([^;]+)/) || [])[1] || '';
  const convId = '0:1:98478746276:744786308115968';
  const shortId = '7672290885698159141';

  const reqBody = buildRequest(convId, shortId, '9999999999999999');
  const res = await fetch('https://imapi.douyin.com/v1/message/get_by_conversation', {
    method: 'POST',
    headers: {
      Cookie: 'sessionid=' + sessionid + '; sessionid_ss=' + sessionid + ';',
      'Content-Type': 'application/x-protobuf',
      Accept: 'application/x-protobuf',
      Origin: 'https://www.douyin.com',
      Referer: 'https://www.douyin.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: reqBody,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log('HTTP', res.status, 'BYTES', buf.length);
  const p = parseResponse(buf);
  console.log('MSGS', p.msgs.length, 'hasMore', p.hasMore, 'nextTs', p.nextTs);
  for (const m of p.msgs) {
    let text = '';
    try {
      const j = JSON.parse(m.content_json || '{}');
      text = j.text || '';
    } catch {}
    console.log('---', {
      server_id: m.server_id,
      sender_uid: m.sender_uid,
      sender_sec_uid: (m.sender_sec_uid || '').slice(0, 30),
      type_code: m.type_code,
      text: text.slice(0, 100),
    });
  }
})();
