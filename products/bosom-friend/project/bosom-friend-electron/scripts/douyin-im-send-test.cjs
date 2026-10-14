const fs = require('fs');
const crypto = require('crypto');

const JAVA_DIR = 'C:/Users/Jay/AppData/Local/Temp/dyim';

function extractJavaConst(fileName, varName) {
  const src = fs.readFileSync(JAVA_DIR + '/' + fileName, 'utf8');
  const re = new RegExp(varName + '\\s*=\\s*"([^"]+)"');
  const m = src.match(re);
  if (!m) throw new Error('const not found: ' + varName);
  return m[1];
}

// ---------- protobuf codec ----------
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

function parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const num = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    let value;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      value = v.value;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const l = Number(len.value);
      value = buf.subarray(pos, pos + l);
      pos += l;
    } else if (wire === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error('wire type ' + wire);
    }
    fields.push({ num, wire, value });
  }
  return fields;
}

function encodeFields(fields) {
  const sorted = [...fields].sort((a, b) => a.num - b.num);
  const chunks = [];
  for (const f of sorted) {
    const tag = writeVarint((BigInt(f.num) << 3n) | BigInt(f.wire));
    chunks.push(tag);
    if (f.wire === 0) {
      chunks.push(writeVarint(f.value));
    } else if (f.wire === 2) {
      const b = Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value);
      chunks.push(writeVarint(b.length));
      chunks.push(b);
    } else if (f.wire === 1) {
      chunks.push(f.value);
    } else if (f.wire === 5) {
      chunks.push(f.value);
    }
  }
  return Buffer.concat(chunks);
}

function getField(fields, num) {
  return fields.find((f) => f.num === num);
}

function setVarintField(fields, num, value) {
  const f = fields.find((x) => x.num === num);
  if (f) {
    f.wire = 0;
    f.value = BigInt(value);
  } else {
    fields.push({ num, wire: 0, value: BigInt(value) });
  }
}

function setStringField(fields, num, value) {
  const f = fields.find((x) => x.num === num);
  const buf = Buffer.from(value, 'utf8');
  if (f) {
    f.wire = 2;
    f.value = buf;
  } else {
    fields.push({ num, wire: 2, value: buf });
  }
}

function updateEmbedded(root, path, fn) {
  // path: array of field numbers leading to the embedded message to modify
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const num = path[i];
    const f = getField(cur, num);
    if (!f) throw new Error('missing field ' + num);
    const parsed = parseFields(f.value);
    if (i === path.length - 1) {
      fn(parsed);
      f.value = encodeFields(parsed);
    } else {
      // replace in parent after walking deeper
      const idx = cur.indexOf(f);
      cur = parsed; // continue
      const walkIdx = idx;
      // after inner modification, re-encode into parent
      const outer = root;
      void outer;
      void walkIdx;
    }
  }
  return root;
}

function updateEmbeddedRecursive(root, path, fn) {
  if (path.length === 0) {
    fn(root);
    return root;
  }
  const num = path[0];
  const f = getField(root, num);
  if (!f) throw new Error('missing field ' + num);
  const parsed = parseFields(f.value);
  updateEmbeddedRecursive(parsed, path.slice(1), fn);
  f.value = encodeFields(parsed);
  return root;
}

// ---------- main ----------
(async () => {
  const templateB64 = extractJavaConst('MessageSender.java', 'TEXT_MESSAGE_TEMPLATE');
  const queryParams = extractJavaConst('MessageSender.java', 'QUERY_PARAMS');
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
  const cookieStr = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/douyin-cookie.txt', 'utf8').trim();
  const m = cookieStr.match(/sessionid=([^;]+)/);
  const sessionid = m ? m[1] : '';

  const template = Buffer.from(templateB64, 'base64');
  const root = parseFields(template);

  const conversationId = '0:1:98478746276:744786308115968';
  const conversationShortId = '7672290885698159141';
  const replyText = '谢谢你的私信！我是知音AI内容营销系统，可以帮你一站式完成内容创作、多平台发布和7×24小时客户接待。想了解哪方面呢？';
  const contentJson = JSON.stringify({
    mention_users: [],
    aweType: 700,
    richTextInfos: [],
    text: replyText,
  });
  const clientMessageId = crypto.randomUUID();

  updateEmbeddedRecursive(root, [8, 100], (contentFields) => {
    setStringField(contentFields, 1, conversationId);
    setVarintField(contentFields, 2, 1);
    setVarintField(contentFields, 3, conversationShortId);
    setStringField(contentFields, 4, contentJson);
    setStringField(contentFields, 8, clientMessageId);
  });

  const body = encodeFields(root);
  console.log('BODY_BYTES', body.length, 'clientMessageId', clientMessageId);

  const url = 'https://imapi.douyin.com/v1/message/send?' + queryParams;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: 'sessionid=' + sessionid + '; sessionid_ss=' + sessionid + ';',
      accept: 'application/x-protobuf',
      'content-type': 'application/x-protobuf',
      'user-agent': ua,
      origin: 'https://www.douyin.com',
      referer: 'https://www.douyin.com/',
      'accept-language': 'zh-CN,zh;q=0.9',
      'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
    },
    body,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log('HTTP', res.status, 'RESP_BYTES', buf.length);
  if (buf.length > 0) {
    const resp = parseFields(buf);
    const statusF = getField(resp, 4);
    const errF = getField(resp, 3);
    const dataF = getField(resp, 6);
    let extra = null;
    if (dataF) {
      const data = parseFields(dataF.value);
      const miF = getField(data, 100);
      if (miF) {
        const mi = parseFields(miF.value);
        const eF = getField(mi, 6);
        if (eF) extra = eF.value.toString('utf8');
      }
    }
    console.log('STATUS_MESSAGE', statusF ? statusF.value.toString('utf8') : '?');
    console.log('ERROR_CODE', errF ? errF.value.toString() : '?');
    console.log('EXTRA_INFO', extra);
    console.log('RESP_HEX', buf.subarray(0, 80).toString('hex'));
  }
})();
