/*
 * 抖音网页版私信（IM）客户端
 * 基于 imapi.douyin.com 的 protobuf 接口实现（会话列表 / 消息拉取 / 消息发送）
 */
import { AccountModel } from '../../db/models/account';
import crypto from 'node:crypto';
import abogus from './abogus.cjs';
import msTokenConfig from './ms-token-config.json';

const API_BASE = 'https://imapi.douyin.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

// 拉取陌生人会话列表的 protobuf 请求模板
const STRANGER_TEMPLATE = 'COkHEN1OGgUxLjEuMyIxaGFzaC5KSU9zMGhTRDh4dGNIeW1PTVpNMlB3TmJtTDM2bU5GYWU2OUdBT21nenV3PSgDMAE6OjhhYTJkY2I6RGV0YWNoZWQ6IDhhYTJkY2I4OGI0MTUzODg4NTE2OGU0YWZiYmQyYjZiYWM4YWVmYjJCCcI+BggAEAEYAUoBMFoJZG91eWluX3BjehMKC3Nlc3Npb25fYWlkEgQ2MzgzehAKC3Nlc3Npb25fZGlkEgEwehUKCGFwcF9uYW1lEglkb3V5aW5fcGN6FQoPcHJpb3JpdHlfcmVnaW9uEgJjbnqDAQoKdXNlcl9hZ2VudBJ1TW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzOC4wLjAuMCBTYWZhcmkvNTM3LjM2ehYKDmNvb2tpZV9lbmFibGVkEgR0cnVlehkKEGJyb3dzZXJfbGFuZ3VhZ2USBXpoLUNOehwKEGJyb3dzZXJfcGxhdGZvcm0SCE1hY0ludGVsehcKDGJyb3dzZXJfbmFtZRIHTW96aWxsYXqAAQoPYnJvd3Nlcl92ZXJzaW9uEm01LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzOC4wLjAuMCBTYWZhcmkvNTM3LjM2ehYKDmJyb3dzZXJfb25saW5lEgR0cnVlehQKDHNjcmVlbl93aWR0aBIEMzQ0MHoVCg1zY3JlZW5faGVpZ2h0EgQxNDQwej4KB3JlZmVyZXISM2h0dHBzOi8vd3d3LmRvdXlpbi5jb20vdXNlci9zZWxmP2Zyb21fdGFiX25hbWU9bWFpbnoeCg10aW1lem9uZV9uYW1lEg1Bc2lhL1NoYW5naGFpeg0KCGRldmljZUlkEgEwehwKBXdlYmlkEhM3MzYwOTcxNzMxMTMxNTY1NTgzejoKAmZwEjR2ZXJpZnlfbWQ0Y2wzbTZfWDlXb2lDT1ZfbW5vNl80SzFsX0J5NmRfdXhwV1ppOWVGWGdheg0KCGlzLXJldHJ5EgEwkAEEqgEKZG91eWluX3dlYrIBB3dlYl9zZGu6AYUBdHMuMi5kYmEyNDE3ZGI0MzFkZDgxZTQxM2M5ODU3MmYyMTRiMmM1YzFhNmE5YTJiODNkZTI0MTk5NTdlYjExNjljYjU0YzRmYmU4N2QyMzE5Y2YwNTMxODYyNGNlZGExNDkxMWNhNDA2ZGVkYmViZWRkYjJlMzBmY2U4ZDRmYTAyNTc1ZMIBfGNIVmlMa0pGYjBsMFEwWXJUVkpoV0hFcmFIVmlMMk5WYTFaSlpHY3dka3ByU21KdmVrMWFkbVZrVGpKUGFtZG5ka1pMY1N0UFRrSlVTa3RPZG1OeWJrWlpRMjlwY2toSFQwRnJkQzlqUjBWSFpubExLMEZDUVZSamR6MD0=';
// 发送文本消息的 protobuf 请求模板
const TEXT_MESSAGE_TEMPLATE = 'CGQQvNAFGgUxLjEuMyIxaGFzaC5pNVlMc2lmZnM3MWh6Tko5OGJxcFV1T1o5Uk5QR1NuTVJLS05LU0NEdHM4PSgDMAA6OjhhYTJkY2I6RGV0YWNoZWQ6IDhhYTJkY2I4OGI0MTUzODg4NTE2OGU0YWZiYmQyYjZiYWM4YWVmYjJClQOiBpEDCiAwOjE6ODgyMTQ0NTQyMDg6NDIxMzc4MzU5NjExMDU2NBABGJuEgtbq2JDcZyJLeyJtZW50aW9uX3VzZXJzIjpbXSwiYXdlVHlwZSI6NzAwLCJyaWNoVGV4dEluZm9zIjpbXSwidGV4dCI6IuS6uuW3peWbnuWkjSJ9KhUKEXM6bWVudGlvbmVkX3VzZXJzEgAqOwoTczpjbGllbnRfbWVzc2FnZV9pZBIkNmJkYzFiZGItZWJiMS00ZDNlLWE4MmItZGExMTkzYTA4NDY2Kh0KB3M6c3RpbWUSEjE3NTY4NzU1MzQwNjcuMjIzOTAHOnkxbGFXeHdJT3dSSk93Vm1rT3NwMXY0dEtVRWVDYXp2U0wzdllLMHRoT3RURnBJQ1JuSDllaDh6cElNVDQwd0FDNHltQUhRVWppellRZGdib0dXUDllbnFRZ0FHSVBtM0xnY2JJNDdkdkFDMFZaMlVBcVJKQUExT1hBQiQ2YmRjMWJkYi1lYmIxLTRkM2UtYTgyYi1kYTExOTNhMDg0NjZKATBaCWRvdXlpbl9wY3rkAQoXaWRlbnRpdHlfc2VjdXJpdHlfdG9rZW4SyAF7InRva2VuIjoiQ2poeW5iclB0UG1VcHBhUVI0ektZNEF2LXVYZS1POGJJRnJDWXFmVVJCaW5VVU9fSHljSkNzSXk4YU1HOExac3RfTXRIMEIxajhxUU5ScEtDandBQUFBQUFBQUFBQUFBVDI0VXdlZVFvQmdZanlOR054eUE2U3Vqb0hsVTVKOVppX2VHYml3RkFUYVN0SkU4dnhGYUV3TVBuVXR6VVVUUlVtWVE2Wm43RFJqMnNkRnNJQUlpQVFPbFZqX0EifXoyChtpZGVudGl0eV9zZWN1cml0eV9kZXZpY2VfaWQSEzc1MzgzNjE2NDA2NzA0NjM1MDd6HQoVaWRlbnRpdHlfc2VjdXJpdHlfYWlkEgQ2MzgzehMKC3Nlc3Npb25fYWlkEgQ2MzgzehAKC3Nlc3Npb25fZGlkEgEwehUKCGFwcF9uYW1lEglkb3V5aW5fcGN6FQoPcHJpb3JpdHlfcmVnaW9uEgJjbnqDAQoKdXNlcl9hZ2VudBJ1TW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzOC4wLjAuMCBTYWZhcmkvNTM3LjM2ehYKDmNvb2tpZV9lbmFibGVkEgR0cnVlehkKEGJyb3dzZXJfbGFuZ3VhZ2USBXpoLUNOehwKEGJyb3dzZXJfcGxhdGZvcm0SCE1hY0ludGVsehcKDGJyb3dzZXJfbmFtZRIHTW96aWxsYXqAAQoPYnJvd3Nlcl92ZXJzaW9uEm01LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEzOC4wLjAuMCBTYWZhcmkvNTM3LjM2ehYKDmJyb3dzZXJfb25saW5lEgR0cnVlehQKDHNjcmVlbl93aWR0aBIEMzQ0MHoVCg1zY3JlZW5faGVpZ2h0EgQxNDQwegsKB3JlZmVyZXISAHoeCg10aW1lem9uZV9uYW1lEg1Bc2lhL1NoYW5naGFpeg0KCGRldmljZUlkEgEwehwKBXdlYmlkEhM3NTM4MzYxNjQwNjcwNDYzNTA3ejoKAmZwEjR2ZXJpZnlfbWViNXdseHdfdWcwdUpOZVdfaEdldl80UW1MXzlraDlfc0J4SENtWTVSMzdZeg0KCGlzLXJldHJ5EgEwkAEEqgEKZG91eWluX3dlYrIBB3dlYl9zZGu6AYUBdHMuMi44MmQyNTUxYmU0ZDJjNDczY2FmNWNjODFkYTdmOTc3ZGRlMjliZjVkOGM0NjdiYTgyMGY2ZTE1NmEyYzg1OGQxYzRmYmU4N2QyMzE5Y2YwNTMxODYyNGNlZGExNDkxMWNhNDA2ZGVkYmViZWRkYjJlMzBmY2U4ZDRmYTAyNTc1ZMIBfGNIVmlMa0pOT0VKeWMzQkxSMHg0V25kV1NuZ3pWR04wVmxCa2FUWkpOMUpaYVU5clFsVm5Sbk55Ym1oMk5qUXlkSHBhU2pSd1NVd3ZkbmxqV0N0RmRrRjRZbmRJZUhaTmR6VlhNVGxZVFUxMVFVbFdNRTh5T0dwblZUMD3KAWBNRVVDSUhDUG1wMENSTFduV0phOXVnSHQveFFQSUVxbzFqQTJXSlQ0WStCc0RXS29BaUVBdnhjR2tSTlFOTStKKzE5THVDOGNEUStOUUtDL1o0VzR0UW9hUTBsZi9aND0=';
// 发送接口的静态查询参数（msToken/a_bogus/verifyFp/fp）
const SEND_QUERY_PARAMS = 'msToken=NG352w3KohApjL5Te25wsll7d2vu0WPOgwsqBk6X_jAe3Zha2Qi9GGfZsm5Ojanbw9f5R1wCVC6E8-YpHwmZLGSup8fH1QXpz2WaGgdR6qsfzHSdLbgOPejpEZE5fHSPK3MSS7HB7dEAYv4LrT5BR1UZeW2ChrtuoY4a-wmow-C7xve-I7gadg%3D%3D&a_bogus=mjsnkHWwQZQRFd%2FGYOTzeV2UltLMrB8yTtidbJIPCOPhOhMYkmNygPc2GozJPccsEWMsh1c7iE0%2FTxxcT4XwZH9kwmkvuKXfomOn908o%2FqwmT0t8DHfZCLzwtJtG85Gim5KWJlDXA0AcIjO4ENakUpArtATqsOhdKNafddUaT9eDgzs9TZMBPwXWrDCCU-3h8TibHIj%3D&verifyFp=verify_meb5wlxw_ug0uJNeW_hGev_4QmL_9kh9_sBxHCmY5R37Y&fp=verify_meb5wlxw_ug0uJNeW_hGev_4QmL_9kh9_sBxHCmY5R37Y';
const VERIFY_FP = 'verify_meb5wlxw_ug0uJNeW_hGev_4QmL_9kh9_sBxHCmY5R37Y';
const CREATOR_BASE = 'https://creator.douyin.com';
const CREATOR_CHAT_URL = CREATOR_BASE + '/creator-micro/data/following/chat';

// 令牌缓存，避免每次发送都重复请求（msToken 5 分钟 / 身份令牌 10 分钟）
const MS_TOKEN_TTL_MS = 5 * 60 * 1000;
const IDENTITY_TOKEN_TTL_MS = 10 * 60 * 1000;
let cachedMsToken = { value: '', expiresAt: 0 };
const cachedIdentity = new Map<number, { value: { token: string; deviceId: string }; expiresAt: number }>();

/**
 * 带超时的 fetch：外部接口挂起会锁死私信接待链路，超时保护是底线。
 */
function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/** 带重试的请求：外部 IM 接口偶发断连，重试避免漏掉私信 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  timeoutMs = 15000,
  retries = 2,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs)
      if (res.ok) {
        return res
      }
      lastError = new Error(`HTTP ${res.status}`)
      if (res.status < 500 && res.status !== 429) {
        break
      }
    }
    catch (e) {
      lastError = e
    }
    if (attempt < retries) {
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('请求失败')
}

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

/** protobuf 字段（value 兼容 Buffer 与 bigint，由 wire 类型区分） */
interface Field {
  num: number;
  wire: number;
  value: any;
}

function writeVarint(n: number | bigint): Buffer {
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

function readVarint(buf: Buffer, pos: number): { value: bigint; pos: number } {
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

function encodeString(fn: number, s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarint((BigInt(fn) << 3n) | 2n), writeVarint(b.length), b]);
}

function encodeVarintField(fn: number, v: number | bigint | string): Buffer {
  return Buffer.concat([writeVarint((BigInt(fn) << 3n) | 0n), writeVarint(BigInt(v))]);
}

function encodeBytes(fn: number, buf: Buffer): Buffer {
  return Buffer.concat([writeVarint((BigInt(fn) << 3n) | 2n), writeVarint(buf.length), buf]);
}

function parseFields(buf: Buffer): Field[] {
  const fields: Field[] = [];
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

function encodeFields(fields: Field[]): Buffer {
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

function setStringField(fields: Field[], num: number, value: string) {
  const f = fields.find((x) => x.num === num);
  const buf = Buffer.from(value, 'utf8');
  if (f) {
    f.wire = 2;
    f.value = buf;
  } else {
    fields.push({ num, wire: 2, value: buf });
  }
}

function setVarintField(fields: Field[], num: number, value: number | bigint | string) {
  const f = fields.find((x) => x.num === num);
  if (f) {
    f.wire = 0;
    f.value = BigInt(value);
  } else {
    fields.push({ num, wire: 0, value: BigInt(value) });
  }
}

function updateEmbeddedRecursive(root: Field[], path: number[], fn: (fields: Field[]) => void) {
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

function getField(fields: Field[], num: number): Field | undefined {
  return fields.find((f) => f.num === num);
}

function extractField(buf: Buffer, target: number): Buffer | null {
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

function parseMessage(buf: Buffer): Record<string, any> {
  const r: Record<string, any> = {};
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

function parseMessagesResponse(data: Buffer) {
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
    const cookies = JSON.parse(account.loginCookie) as { name: string; value: string }[];
    const c = cookies.find((x) => x.name === 'sessionid');
    return c ? c.value : '';
  } catch {
    return '';
  }
}

function getAllCookies(account: AccountModel): string {
  try {
    const cookies = JSON.parse(account.loginCookie) as { name: string; value: string }[];
    if (!Array.isArray(cookies)) return '';
    const seen = new Set<string>();
    return cookies
      .filter((c) => {
        const k = c.name + '@' + (c as { domain?: string }).domain;
        if (!c.name || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

function buildHeaders(cookieStr: string) {
  return {
    Cookie: cookieStr,
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

function updateSendHeader(root: any, name: string, value: string): boolean {
  for (const f of root) {
    if (f.num !== 15) continue;
    const p = parseFields(f.value);
    const nf = p.find((x) => x.num === 1);
    if (nf && nf.value.toString('utf8') === name) {
      setStringField(p, 2, value);
      f.value = encodeFields(p);
      return true;
    }
  }
  return false;
}

function parseConversationList(buf: Buffer): { conversations: DmConversation[] } {
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

  private get cookieStr(): string {
    return getAllCookies(this.account);
  }

  /**
   * 通过 mssdk 接口生成新鲜 msToken
   */
  private async genRealMsToken(): Promise<string> {
    if (cachedMsToken.value && Date.now() < cachedMsToken.expiresAt) {
      return cachedMsToken.value;
    }
    const cfg = msTokenConfig as {
      url: string;
      magic: number;
      version: number;
      dataType: number;
      strData: string;
      userAgent: string;
    };
    const payload = {
      magic: cfg.magic,
      version: cfg.version,
      dataType: cfg.dataType,
      strData: cfg.strData,
      tspFromClient: Date.now(),
    };
    const res = await fetchWithTimeout(cfg.url, {
      method: 'POST',
      headers: { 'User-Agent': cfg.userAgent || USER_AGENT, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') || '').split(',');
    for (const c of setCookies) {
      const m = c.match(/msToken=([^;]+)/);
      if (m) {
        cachedMsToken = { value: m[1], expiresAt: Date.now() + MS_TOKEN_TTL_MS };
        return m[1];
      }
    }
    throw new Error('msToken 生成失败');
  }

  /**
   * 获取创作者 IM 身份 token（用于私信发送 headers）
   */
  private async fetchCreatorIdentity(cookieStr: string): Promise<{ token: string; deviceId: string }> {
    const cached = cachedIdentity.get(this.account.id);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    const cookieMap: Record<string, string> = {};
    try {
      const cookies = JSON.parse(this.account.loginCookie) as { name: string; value: string }[];
      for (const c of cookies) cookieMap[c.name] = c.value;
    } catch {}
    const headers = {
      'User-Agent': USER_AGENT,
      Referer: CREATOR_CHAT_URL,
      Origin: CREATOR_BASE,
      Accept: 'application/json, text/javascript',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieStr,
      'x-tt-passport-csrf-token':
        cookieMap.passport_csrf_token || cookieMap.passport_csrf_token_default || '',
    };
    const params = new URLSearchParams({
      scene: 'im_send_msg',
      auto_retry_req: '0',
      skip_verify: '0',
      identity_token_force_get_tag: '0',
      passport_jssdk_version: '5.1.4',
      passport_jssdk_type: 'lite',
      is_from_ttaccountsdk: '1',
      aid: '2906',
      language: 'zh',
      account_app_language: 'en-US',
      id_token_version: '2.1.5',
    });
    const res = await fetchWithTimeout(
      `${CREATOR_BASE}/passport/safe/get_identity_security_token/?${params.toString()}`,
      { headers },
    );
    const j = (await res.json()) as {
      message?: string;
      data?: { identity_security_token?: string; device_id?: number | string };
    };
    if (j.message !== 'success' || !j.data?.identity_security_token) {
      throw new Error('身份令牌获取失败: ' + JSON.stringify(j).slice(0, 200));
    }
    const value = {
      token: j.data.identity_security_token,
      deviceId: String(j.data.device_id || ''),
    };
    cachedIdentity.set(this.account.id, { value, expiresAt: Date.now() + IDENTITY_TOKEN_TTL_MS });
    return value;
  }

  /**
   * 拉取陌生人会话列表（未回复的待处理私信）
   */
  async getConversations(): Promise<DmConversation[]> {
    const body = Buffer.from(STRANGER_TEMPLATE, 'base64');
    const res = await fetchWithRetry(API_BASE + '/v1/stranger/get_conversation_list', {
      method: 'POST',
      headers: buildHeaders(this.cookieStr),
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
    const res = await fetchWithTimeout(API_BASE + '/v1/message/get_by_conversation', {
      method: 'POST',
      headers: buildHeaders(this.cookieStr),
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
      // 1. 新鲜 msToken + a_bogus
      const freshMsToken = await this.genRealMsToken();
      const params2Str = 'msToken=' + freshMsToken + '&verifyFp=' + VERIFY_FP + '&fp=' + VERIFY_FP;
      const aBogus = abogus.generateABogus(params2Str, USER_AGENT);

      // 2. 新鲜身份令牌（含设备 id）
      const identity = await this.fetchCreatorIdentity(this.cookieStr);

      // 3. 更新模板 headers（身份令牌/设备/应用 id）
      const template = Buffer.from(TEXT_MESSAGE_TEMPLATE, 'base64');
      const root = parseFields(template);
      const headerUpdates: [string, string][] = [
        ['identity_security_token', JSON.stringify({ token: identity.token })],
        ['identity_security_device_id', identity.deviceId],
        ['identity_security_aid', '2906'],
        ['session_aid', '2906'],
        ['webid', identity.deviceId],
      ];
      for (const [name, value] of headerUpdates) {
        updateSendHeader(root, name, value);
      }

      // 4. 会话信息 + 消息内容
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
      const url =
        API_BASE + '/v1/message/send?' + params2Str + '&a_bogus=' + encodeURIComponent(aBogus);
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: buildHeaders(this.cookieStr),
        body: new Uint8Array(body).buffer as ArrayBuffer,
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
    const res = await fetchWithTimeout('https://www.douyin.com/aweme/v1/web/im/user/info/', {
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
    const j = (await res.json()) as {
      data?: { sec_uid?: string; uid?: number | string; nickname?: string; unique_id?: string }[];
    };
    return (j.data || []).map((d) => ({
      secUid: d.sec_uid,
      uid: d.uid ? String(d.uid) : undefined,
      nickname: d.nickname,
      uniqueId: d.unique_id,
    }));
  }
}
