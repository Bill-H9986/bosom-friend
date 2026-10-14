/*
 * 抖音 X-Bogus (a_bogus) 签名算法 Node 移植
 * 移植自 Rockedw/douyin-web-api-sdk 的 ABogusUtil.java
 */

// ---------- SM3 ----------
function sm3(bytes) {
  const IV = [
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
    0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
  ];
  const Tj = (j) => (j < 16 ? 0x79cc4519 : 0x7a879d8a);
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const P0 = (x) => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
  const P1 = (x) => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
  const FF = (j, x, y, z) => (j < 16 ? (x ^ y ^ z) : ((x & y) | (x & z) | (y & z))) >>> 0;
  const GG = (j, x, y, z) => (j < 16 ? (x ^ y ^ z) : ((x & y) | (~x & z))) >>> 0;

  const data = new Uint8Array(bytes);
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000) >>> 0);
  view.setUint32(padded.length - 4, bitLen >>> 0);

  let [A, B, C, D, E, F, G, H] = IV;
  const W = new Array(68);
  const W1 = new Array(64);

  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      W[j] = view.getUint32(i + j * 4) >>> 0;
    }
    for (let j = 16; j < 68; j++) {
      const x = W[j - 16] ^ W[j - 9] ^ rotl(W[j - 3], 15);
      W[j] = (P1(x) ^ rotl(W[j - 13], 7) ^ W[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) {
      W1[j] = (W[j] ^ W[j + 4]) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [A, B, C, D, E, F, G, H];
    for (let j = 0; j < 64; j++) {
      const ss1 = rotl((rotl(a, 12) + e + rotl(Tj(j), j % 32)) >>> 0, 7);
      const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
      const tt1 = (FF(j, a, b, c) + d + ss2 + W1[j]) >>> 0;
      const tt2 = (GG(j, e, f, g) + h + ss1 + W[j]) >>> 0;
      d = c;
      c = rotl(b, 9);
      b = a;
      a = tt1;
      h = g;
      g = rotl(f, 19);
      f = e;
      e = P0(tt2);
    }
    A = (A ^ a) >>> 0;
    B = (B ^ b) >>> 0;
    C = (C ^ c) >>> 0;
    D = (D ^ d) >>> 0;
    E = (E ^ e) >>> 0;
    F = (F ^ f) >>> 0;
    G = (G ^ g) >>> 0;
    H = (H ^ h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [A, B, C, D, E, F, G, H].forEach((v, i) => outView.setUint32(i * 4, v >>> 0));
  return Buffer.from(out);
}

// ---------- constants ----------
const AID = 6383;
const PAGE_ID = 0;
const SALT = 'cus';
const UA_KEY = [0, 1, 14];
const BASE64_ALPHABET_0 = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const BASE64_ALPHABET_1 = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const SORT_INDEX_ARRAY_1 = [18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28, 32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71];
const SORT_INDEX_ARRAY_2 = [18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37, 44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71];

// ---------- helpers ----------
function randomFingerprint() {
  const rnd = (min, max) => min + Math.floor(Math.random() * (max - min));
  const innerWidth = rnd(1024, 1920);
  const innerHeight = rnd(768, 1080);
  const outerWidth = innerWidth + rnd(24, 32);
  const outerHeight = innerHeight + rnd(75, 90);
  const screenX = 0;
  const screenY = [0, 30][rnd(0, 2)];
  const availWidth = rnd(1280, 1920);
  const availHeight = rnd(800, 1080);
  const data = [
    innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY,
    0, 0, availWidth, availHeight, availWidth, availHeight,
    innerWidth, innerHeight, 24, 24,
  ];
  return data.join('|') + '||win';
}

function addSalt(content) {
  return content + SALT;
}

function rc4(input) {
  const s = new Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + UA_KEY[i % UA_KEY.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const chars = Buffer.from(input, 'utf8');
  const out = new Uint8Array(chars.length);
  let i = 0;
  j = 0;
  for (let idx = 0; idx < chars.length; idx++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    const k = s[(s[i] + s[j]) % 256];
    out[idx] = chars[idx] ^ k;
  }
  return Buffer.from(out);
}

const TRANSFORM_TABLE = [
  121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101, 250, 207, 198, 50, 139, 227, 220, 105, 97, 143, 34, 28, 194, 215, 18, 100, 159, 160, 43, 8, 169, 217, 180, 120, 247, 45, 90, 11, 27, 197, 46, 3, 84, 72, 5, 68, 62, 56, 221, 75, 144, 79, 73, 161, 178, 81, 64, 187, 134, 117, 186, 118, 16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150, 110, 219, 199, 255, 181, 254, 48, 4, 195, 248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104, 96, 83, 80, 127, 236, 108, 154, 126, 204, 15, 20, 135, 112, 158, 13, 1, 188, 164, 210, 237, 222, 98, 212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251, 10, 173, 152, 58, 138, 54, 141, 185, 33, 157, 31, 252, 132, 233, 235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109, 57, 24, 38, 113, 209, 245, 2, 119, 153, 229, 189, 214, 230, 174, 232, 63, 52, 205, 86, 140, 66, 175, 111, 171, 246, 133, 238, 193, 99, 60, 74, 91, 225, 51, 76, 37, 145, 211, 166, 151, 213, 206, 0, 200, 244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67, 85, 224, 155, 226, 242, 87, 177, 146, 70, 190, 12, 162, 19, 137, 114, 25, 165, 163, 192, 23, 59, 9, 94, 179, 107, 35, 7, 142, 131, 239, 203, 149, 136, 61, 249, 14, 156,
];

function transform(input) {
  const big = [...TRANSFORM_TABLE];
  const out = new Uint8Array(input.length);
  let j = big[1];
  let initial = 0;
  let e = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    let sum;
    if (i === 0) {
      initial = big[j];
      sum = j + initial;
      big[1] = initial;
      big[j] = j;
    } else {
      sum = initial + e;
    }
    sum %= big.length;
    const f = big[sum];
    out[i] = (b ^ f) & 0xff;
    e = big[(i + 2) % big.length] % big.length;
    sum = (j + e) % big.length;
    initial = big[sum];
    const k = (i + 2) % big.length;
    big[sum] = big[k];
    big[k] = initial;
    j = sum;
  }
  return Buffer.from(out);
}

function base64(input, alphabet, paddingMode) {
  if (!input || input.length === 0) return null;
  let binary = '';
  for (const byte of input) {
    let s = byte.toString(2);
    while (s.length < 8) s = '0' + s;
    binary += s;
  }
  binary += '0'.repeat((6 - (input.length * 8) % 6) % 6);
  let result = '';
  for (let i = 0; i < binary.length; i += 6) {
    const segment = binary.substring(i, i + 6);
    result += alphabet[parseInt(segment, 2)];
  }
  if (paddingMode === 0) {
    const paddingLength = Math.floor((((6 - (input.length * 8) % 6) % 6) + 1) / 2);
    result += '='.repeat(paddingLength);
  } else if (paddingMode === 1) {
    const paddingLength = (4 - (result.length % 4)) % 4;
    result += '='.repeat(paddingLength);
  }
  return result;
}

function generateABogus(params, userAgent) {
  const fingerprint = randomFingerprint();
  const startEncryption = Math.floor(Date.now() / 1000) * 1000;
  const bytes1 = sm3(sm3(Buffer.from(addSalt(params), 'utf8')));
  const bytes2 = sm3(sm3(Buffer.from(addSalt('GET'), 'utf8')));
  const bytes3 = sm3(Buffer.from(base64(rc4(userAgent), BASE64_ALPHABET_1, 0), 'utf8'));
  const endEncryption = Math.floor(Date.now() / 1000) * 1000;

  const data = new Array(128).fill(0);
  data[8] = 3;
  data[18] = 44;
  data[20] = (startEncryption >> 24) & 255;
  data[21] = (startEncryption >> 16) & 255;
  data[22] = (startEncryption >> 8) & 255;
  data[23] = startEncryption & 255;
  data[24] = Math.floor(startEncryption / 256 / 256 / 256 / 256);
  data[25] = Math.floor(startEncryption / 256 / 256 / 256 / 256 / 256);
  data[31] = 1 % 256 & 255;
  data[37] = 14 & 255;
  data[38] = bytes1[21];
  data[39] = bytes1[22];
  data[40] = bytes2[21];
  data[41] = bytes2[22];
  data[42] = bytes3[23];
  data[43] = bytes3[24];
  data[44] = (endEncryption >> 24) & 255;
  data[45] = (endEncryption >> 16) & 255;
  data[46] = (endEncryption >> 8) & 255;
  data[47] = endEncryption & 255;
  data[48] = data[8];
  data[49] = Math.floor(endEncryption / 256 / 256 / 256 / 256);
  data[50] = Math.floor(endEncryption / 256 / 256 / 256 / 256 / 256);
  data[51] = (PAGE_ID >> 24) & 255;
  data[52] = (PAGE_ID >> 16) & 255;
  data[53] = (PAGE_ID >> 8) & 255;
  data[54] = PAGE_ID & 255;
  data[55] = PAGE_ID;
  data[56] = AID;
  data[57] = AID & 255;
  data[58] = (AID >> 8) & 255;
  data[59] = (AID >> 16) & 255;
  data[60] = (AID >> 24) & 255;
  data[64] = fingerprint.length;
  data[65] = fingerprint.length;

  const sortValueData = SORT_INDEX_ARRAY_1.map((i) => data[i]);
  const fingerprintData = Buffer.from(fingerprint, 'utf8');
  let xor = 0;
  for (let i = 0; i < SORT_INDEX_ARRAY_2.length - 1; i++) {
    if (i === 0) xor = data[SORT_INDEX_ARRAY_2[i]];
    xor ^= data[SORT_INDEX_ARRAY_2[i + 1]];
  }
  const valueData = [...sortValueData, ...fingerprintData, xor];

  const randomData = new Uint8Array(12);
  for (let i = 0; i < 3; i++) {
    const rd = Math.floor(Math.random() * 10000);
    randomData[i * 4] = (((rd & 255) & 170) | 1) & 0xff;
    randomData[i * 4 + 1] = (((rd & 255) & 85) | 2) & 0xff;
    randomData[i * 4 + 2] = (((rd >> 8) & 170) | 5) & 0xff;
    randomData[i * 4 + 3] = (((rd >> 8) & 85) | 40) & 0xff;
  }

  const transformData = transform(valueData);
  const finalData = Buffer.concat([Buffer.from(randomData), transformData]);
  return base64(finalData, BASE64_ALPHABET_0, 1);
}

module.exports = { generateABogus, sm3 };
