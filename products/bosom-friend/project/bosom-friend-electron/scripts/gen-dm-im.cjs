const fs = require('fs');

const JAVA_DIR = 'C:/Users/Jay/AppData/Local/Temp/dyim';

function extractJavaConst(fileName, varName) {
  const src = fs.readFileSync(JAVA_DIR + '/' + fileName, 'utf8');
  const re = new RegExp(varName + '\\s*=\\s*"([^"]+)"');
  const m = src.match(re);
  if (!m) throw new Error('const not found: ' + varName + ' in ' + fileName);
  return m[1];
}

const STRANGER_TEMPLATE = extractJavaConst('StrangerMessageFetcher.java', 'base64Content');
const TEXT_TEMPLATE = extractJavaConst('MessageSender.java', 'TEXT_MESSAGE_TEMPLATE');
const QUERY_PARAMS = extractJavaConst('MessageSender.java', 'QUERY_PARAMS');

const code = `/*
 * 抖音网页版私信（IM）客户端
 * 基于 imapi.douyin.com 的 protobuf 接口实现（会话列表 / 消息拉取 / 消息发送）
 */
import { AccountModel } from '../../db/models/account';
import crypto from 'node:crypto';

const API_BASE = 'https://imapi.douyin.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// 拉取陌生人会话列表的 protobuf 请求模板
const STRANGER_TEMPLATE = '${STRANGER_TEMPLATE}';
// 发送文本消息的 protobuf 请求模板
const TEXT_MESSAGE_TEMPLATE = '${TEXT_TEMPLATE}';
// 发送接口的静态查询参数（msToken/a_bogus/verifyFp/fp）
const SEND_QUERY_PARAMS = '${QUERY_PARAMS}';

export interface DmConversationUser {
  userId?: string;
  secUid?: string;
}

export interface DmConversation {
  conversationShortId: string;
  conversationId: string;
  lastText?: string;
  users: DmConversationUser[];
}

export interface DmMessage {
  serverId: string;
  senderUid?: string;
  senderSecUid?: string;
  text: string;
  createdAtUs?: string;
}

function writeVarint(n) {
  const out = [];
  let v = BigInt(n);
  for (;;) {
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
      break;
    }
    fields.push({ num, wire, value });
  }
  return fields;
}

function encodeFields(fields) {
  const sorted = [...fields].sort((a, b) => a.num - b.num);
  const chunks = [];
  for (const f of sorted) {
    chunks.push(writeVarint((BigInt(f.num) << 3n) | BigInt(f.wire)));
    if (f.wire === 0) {
      chunks.push(writeVarint(f.value));
    } else if (f.wire === 2) {
      const b = Buffer.isBuffer(f.value) ? f.value : Buffer.from(f.value);
      chunks.push(writeVarint(b.length));
      chunks.push(b);
    } else if (f.wire === 1 || f.wire === 5) {
      chunks.push(f.value);
    }
  }
  return Buffer.concat(chunks);
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

function setVarintField(fields, num, value) {
  const f = fields.find((x) => x.num === num);
  if (f) {
    f.wire = 0;
    f.value = BigInt(value);
  } else {
    fields.push({ num, wire: 0, value: BigInt(value) });
  }
}

function updateEmbeddedRecursive(root, path, fn) {
  if (path.length === 0) {
    fn(root);
    return root;
  }
  const num = path[0];
  const f = root.find((x) => x.num === num);
  if (!f) throw new Error('missing field ' + num);
  const parsed = parseFields(f.value);
  updateEmbeddedRecursive(parsed, path.slice(1), fn);
  f.value = encodeFields(parsed);
  return root;
}

function getField(fields, num) {
  return fields.find((f) => f.num === num);
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
        try {
          r.content_json = slice.toString('utf8');
        } catch {}
      } else if (fn === 14) {
        try {
          r.sender_sec_uid = slice.toString('utf8');
        } catch {}
      }
      pos += l;
    } else if (wt === 1) pos += 8;
    else if (wt === 5) pos += 4;
    else break;
  }
  return r;
}

function parseMessagesResponse(data) {
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

function getSessionId(account: AccountModel): string {
  try {
    const cookies = JSON.parse(account.loginCookie);
    const c = cookies.find((x) => x.name === 'sessionid');
    return c ? c.value : '';
  } catch {
    return '';
  }
}

function buildHeaders(sessionId: string) {
  return {
    Cookie: 'sessionid=' + sessionId + '; sessionid_ss=' + sessionId + ';',
    accept: 'application/x-protobuf',
    'content-type': 'application/x-protobuf',
    'user-agent': USER_AGENT,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };
}

function parseConversationList(buf): { conversations: DmConversation[] } {
  const top = parseFields(buf);
  const dataF = getField(top, 6);
  if (!dataF) return { conversations: [] };
  const data = parseFields(dataF.value);
  const msgInfoF = getField(data, 1000);
  if (!msgInfoF) return { conversations: [] };
  const msgInfo = parseFields(msgInfoF.value);
  const conversations = [];
  for (const c of msgInfo.filter((f) => f.num === 4)) {
    const cm = parseFields(c.value);
    const shortIdF = getField(cm, 1);
    const convIdF = getField(cm, 4);
    const detailF = getField(cm, 3);
    const users = cm.filter((f) => f.num === 5).map((u) => {
      const um = parseFields(u.value);
      const uidF = getField(um, 1);
      const secF = getField(um, 5);
      return {
        userId: uidF ? uidF.value.toString() : undefined,
        secUid: secF ? secF.value.toString('utf8') : undefined,
      };
    });
    let lastText = '';
    if (detailF) {
      const detail = parseFields(detailF.value);
      const textF = getField(detail, 8);
      if (textF) {
        try {
          const j = JSON.parse(textF.value.toString('utf8'));
          lastText = j.text || '';
        } catch {
          lastText = '';
        }
      }
    }
    conversations.push({
      conversationShortId: shortIdF ? shortIdF.value.toString() : '',
      conversationId: convIdF ? convIdF.value.toString('utf8') : '',
      lastText,
      users,
    });
  }
  return { conversations };
}

export class DouyinImClient {
  constructor(private account: AccountModel) {}

  private get sessionId(): string {
    return getSessionId(this.account);
  }

  /**
   * 拉取陌生人会话列表（未回复的待处理私信）
   */
  async getConversations(): Promise<DmConversation[]> {
    const body = Buffer.from(STRANGER_TEMPLATE, 'base64');
    const res = await fetch(API_BASE + '/v1/stranger/get_conversation_list', {
      method: 'POST',
      headers: buildHeaders(this.sessionId),
      body,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return parseConversationList(buf).conversations;
  }

  /**
   * 拉取会话消息（从 timestamp 开始向旧翻页）
   */
  async getMessages(
    conversationId: string,
    conversationShortId: string,
    timestamp = '9999999999999999',
  ): Promise<{ msgs: DmMessage[]; nextTs: string | null; hasMore: number }> {
    const inner = Buffer.concat([
      encodeString(1, conversationId),
      encodeVarintField(2, 1),
      encodeVarintField(3, conversationShortId),
      encodeVarintField(4, 1),
      encodeVarintField(5, timestamp),
      encodeVarintField(6, 50),
    ]);
    const queryMsg = encodeBytes(301, inner);
    const body = Buffer.concat([
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
    const res = await fetch(API_BASE + '/v1/message/get_by_conversation', {
      method: 'POST',
      headers: buildHeaders(this.sessionId),
      body,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = parseMessagesResponse(buf);
    return {
      msgs: parsed.msgs.map((m) => {
        let text = '';
        try {
          const j = JSON.parse(m.content_json || '{}');
          text = j.text || '';
        } catch {}
        return {
          serverId: m.server_id || '',
          senderUid: m.sender_uid,
          senderSecUid: m.sender_sec_uid,
          text,
          createdAtUs: m.created_at_us,
        };
      }),
      nextTs: parsed.nextTs,
      hasMore: parsed.hasMore,
    };
  }

  /**
   * 发送文本私信
   */
  async sendMessage(
    conversationId: string,
    conversationShortId: string,
    text: string,
  ): Promise<{ ok: boolean; message?: string }> {
    try {
      const template = Buffer.from(TEXT_MESSAGE_TEMPLATE, 'base64');
      const root = parseFields(template);
      const contentJson = JSON.stringify({
        mention_users: [],
        aweType: 700,
        richTextInfos: [],
        text,
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
      const res = await fetch(API_BASE + '/v1/message/send?' + SEND_QUERY_PARAMS, {
        method: 'POST',
        headers: buildHeaders(this.sessionId),
        body,
      });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200) {
        return { ok: false, message: 'HTTP ' + res.status };
      }
      const resp = parseFields(buf);
      const statusF = getField(resp, 4);
      const statusMessage = statusF ? statusF.value.toString('utf8') : '';
      return statusMessage === 'OK'
        ? { ok: true }
        : { ok: false, message: statusMessage || '发送失败' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 批量查询 IM 用户资料（用于识别身份/获取昵称）
   */
  async resolveUsers(secUids: string[]): Promise<
    { secUid?: string; uid?: string; nickname?: string; uniqueId?: string }[]
  > {
    if (!secUids.length) return [];
    const res = await fetch('https://www.douyin.com/aweme/v1/web/im/user/info/', {
      method: 'POST',
      headers: {
        Cookie: this.sessionId
          ? 'sessionid=' + this.sessionId + '; sessionid_ss=' + this.sessionId + ';'
          : '',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://www.douyin.com',
        Referer: 'https://www.douyin.com/',
        'User-Agent': USER_AGENT,
      },
      body: 'sec_user_ids=' + encodeURIComponent(JSON.stringify(secUids)),
    });
    const j = await res.json();
    return (j.data || []).map((d) => ({
      secUid: d.sec_uid,
      uid: d.uid ? String(d.uid) : undefined,
      nickname: d.nickname,
      uniqueId: d.unique_id,
    }));
  }
}
`;

const outPath = 'C:/Users/Jay/Desktop/AiToEarn-main/project/aitoearn-electron/electron/main/dm/douyin-im.ts';
fs.writeFileSync(outPath, code, 'utf8');
console.log('WROTE', outPath, code.length, 'bytes');
