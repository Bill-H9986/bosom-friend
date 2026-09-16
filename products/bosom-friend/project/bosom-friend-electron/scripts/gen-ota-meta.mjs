import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = 'release/0.9.2';
const exe = '知音-0.9.2.exe';
const exePath = path.join(dir, exe);
const size = fs.statSync(exePath).size;
const fileBuf = fs.readFileSync(exePath);
const sha512 = createHash('sha512').update(fileBuf).digest('base64');
const version = '0.9.2';

// 生成 blockmap（差分更新数据）—— 64KB 块哈希结构
const CHUNK_SIZE = 64 * 1024;
const chunks = [];
const fd = fs.openSync(exePath, 'r');
const buf = Buffer.alloc(CHUNK_SIZE);
let offset = 0;
while (true) {
  const bytes = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
  if (bytes <= 0) break;
  const hash = createHash('sha256').update(buf.subarray(0, bytes)).digest('base64');
  chunks.push([offset, bytes, hash]);
  offset += bytes;
}
fs.closeSync(fd);

const blockmap = {
  version: '1',
  files: [{
    name: exe,
    offset: 0,
    size,
    sha512,
    isDiff: false,
    sha512Header: sha512,
  }],
  packs: [{
    name: exe,
    sha512,
    offset: 0,
    size,
    blockSize: CHUNK_SIZE,
    blocks: chunks.map((c) => ({ offset: c[0], size: c[1], sha512: c[2] })),
  }],
};
fs.writeFileSync(path.join(dir, exe + '.blockmap'), JSON.stringify(blockmap));
console.log('[gen] blockmap: ' + exe + '.blockmap (' + chunks.length + ' blocks)');

const latestYml = [
  'version: ' + version,
  'files:',
  '  - url: ' + exe,
  '    sha512: ' + sha512,
  '    size: ' + size,
  'path: ' + exe,
  'sha512: ' + sha512,
  'releaseDate: "' + new Date().toISOString() + '"',
].join('\n') + '\n';
fs.writeFileSync(path.join(dir, 'latest.yml'), latestYml);
console.log('[gen] latest.yml 生成');
console.log('[gen] sha512 前缀: ' + sha512.slice(0, 16));
console.log('[gen] 完成');
