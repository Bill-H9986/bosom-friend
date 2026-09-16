const fs = require('fs');

// ---------- minimal protobuf reader ----------
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

function parseMessage(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const fieldNum = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    let value;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      value = v.value;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const l = Number(len.value);
      value = buf.subarray(pos, pos + l);
      pos += l;
    } else if (wireType === 1) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 5) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new Error('unsupported wire type ' + wireType + ' at ' + pos);
    }
    fields.push({ fieldNum, wireType, value });
  }
  return fields;
}

function field(fields, num) {
  return fields.find((f) => f.fieldNum === num);
}

function fieldAll(fields, num) {
  return fields.filter((f) => f.fieldNum === num);
}

function asString(bytes) {
  return Buffer.from(bytes).toString('utf8');
}

function asInt(bytes) {
  return Number(Buffer.from(bytes).readBigInt64LE ? null : null) ?? null;
}

function bigIntVal(v) {
  return typeof v === 'bigint' ? v.toString() : String(v);
}

// ---------- extract base64 template from java source ----------
const JAVA_DIR = 'C:/Users/Jay/AppData/Local/Temp/dyim';

function extractTemplate(fileName, varName) {
  const src = fs.readFileSync(JAVA_DIR + '/' + fileName, 'utf8');
  const re = new RegExp(varName + '\\s*=\\s*"([^"]+)"');
  const m = src.match(re);
  if (!m) throw new Error('template not found: ' + varName);
  return Buffer.from(m[1], 'base64');
}

// ---------- main ----------
(async () => {
  const cookieStr = fs.readFileSync('C:/Users/Jay/AppData/Local/Temp/douyin-cookie.txt', 'utf8').trim();
  const m = cookieStr.match(/sessionid=([^;]+)/);
  const sessionid = m ? m[1] : '';
  console.log('SESSIONID', sessionid.slice(0, 12) + '...');

  const reqBody = extractTemplate('StrangerMessageFetcher.java', 'base64Content');
  console.log('REQ_TEMPLATE_BYTES', reqBody.length);

  const url = 'https://imapi.douyin.com/v1/stranger/get_conversation_list';
  const headers = {
    Cookie: 'sessionid=' + sessionid + '; sessionid_ss=' + sessionid + ';',
    accept: 'application/x-protobuf',
    'content-type': 'application/x-protobuf',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="124", "Chromium";v="124"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: reqBody,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  console.log('HTTP', res.status, 'RESP_BYTES', buf.length);
  console.log('RESP_HEAD', buf.subarray(0, 40).toString('hex'));

  if (buf.length === 0) return;

  const top = parseMessage(buf);
  const statusF = field(top, 4);
  console.log('STATUS', statusF ? asString(statusF.value) : '?');
  const dataF = field(top, 6);
  if (!dataF) {
    console.log('NO DATA FIELD');
    return;
  }
  const data = parseMessage(dataF.value);
  const msgInfoF = field(data, 1000);
  if (!msgInfoF) {
    console.log('NO MESSAGE_INFO');
    return;
  }
  const msgInfo = parseMessage(msgInfoF.value);
  const contents = fieldAll(msgInfo, 4);
  console.log('CONTENT_COUNT', contents.length);
  for (const c of contents) {
    const cm = parseMessage(c.value);
    const shortIdF = field(cm, 1);
    const convIdF = field(cm, 4);
    const detailF = field(cm, 3);
    const usersF = fieldAll(cm, 5);
    const detail = detailF ? parseMessage(detailF.value) : [];
    const textF = field(detail, 8);
    const createF = field(detail, 4);
    const users = usersF.map((u) => {
      const um = parseMessage(u.value);
      const uidF = field(um, 1);
      const secF = field(um, 5);
      return {
        userId: uidF ? bigIntVal(uidF.value) : null,
        secUid: secF ? asString(secF.value) : null,
      };
    });
    console.log('---');
    console.log('conversationShortId', shortIdF ? bigIntVal(shortIdF.value) : null);
    console.log('conversationId', convIdF ? asString(convIdF.value) : null);
    console.log('createTime', createF ? bigIntVal(createF.value) : null);
    console.log('textContent', textF ? asString(textF.value).slice(0, 200) : null);
    console.log('users', JSON.stringify(users));
  }
})();
