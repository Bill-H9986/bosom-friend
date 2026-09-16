/*
 * 极简 WebSocket 客户端（RFC6455）
 * Electron 主进程无全局 WebSocket，用于连接 CDP 调试端口
 */
import net from 'node:net';
import crypto from 'node:crypto';

export class SimpleWebSocket {
  private sock: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private msgHandlers: ((data: any) => void)[] = [];
  private openHandler: (() => void) | null = null;

  static connect(url: string): Promise<SimpleWebSocket> {
    const m = url.match(/^ws:\/\/([^:/]+):(\d+)(\/.+)?$/);
    if (!m) throw new Error('无效的 WebSocket URL: ' + url);
    const host = m[1];
    const port = Number(m[2]);
    const path = m[3] || '/';
    return new Promise((resolve, reject) => {
      const ws = new SimpleWebSocket();
      const sock = net.connect(port, host);
      ws.sock = sock;
      const key = crypto.randomBytes(16).toString('base64');
      let upgraded = false;
      sock.on('connect', () => {
        sock.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      sock.on('data', (chunk) => {
        if (!upgraded) {
          ws.buffer = Buffer.concat([ws.buffer, chunk]);
          const headerEnd = ws.buffer.indexOf('\r\n\r\n');
          if (headerEnd >= 0) {
            const header = ws.buffer.subarray(0, headerEnd).toString();
            if (!header.includes('101')) {
              reject(new Error('WebSocket 握手失败: ' + header.split('\r\n')[0]));
              sock.destroy();
              return;
            }
            ws.buffer = ws.buffer.subarray(headerEnd + 4);
            upgraded = true;
            ws.openHandler?.();
            resolve(ws);
          }
          return;
        }
        ws.buffer = Buffer.concat([ws.buffer, chunk]);
        ws.processFrames();
      });
      sock.on('error', (e) => {
        if (!upgraded) reject(e);
        else ws.msgHandlers.forEach((h) => h({ error: e.message }));
      });
      sock.on('close', () => {
        ws.msgHandlers.forEach((h) => h({ closed: true }));
      });
    });
  }

  onOpen(fn: () => void) {
    this.openHandler = fn;
  }

  onMessage(fn: (data: any) => void) {
    this.msgHandlers.push(fn);
  }

  send(obj: any) {
    if (!this.sock || this.sock.destroyed) {
      return;
    }
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x81, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.from([0x81, 0x80 | 126]);
      const ext = Buffer.alloc(2);
      ext.writeUInt16BE(len, 0);
      header = Buffer.concat([header, ext]);
    } else {
      header = Buffer.from([0x81, 0x80 | 127]);
      const ext = Buffer.alloc(8);
      ext.writeBigUInt64BE(BigInt(len), 0);
      header = Buffer.concat([header, ext]);
    }
    try {
      this.sock.write(Buffer.concat([header, mask, masked]));
    }
    catch {
      // 对端断开：静默丢弃本次发送，由 sock error/close 事件通知调用方
    }
  }

  close() {
    try {
      this.sock?.end();
    } catch {}
  }

  private processFrames() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let len = this.buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.subarray(offset, offset + len);
      if (maskKey) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      this.buffer = this.buffer.subarray(offset + len);
      if (opcode === 1) {
        try {
          this.msgHandlers.forEach((h) => h(JSON.parse(payload.toString('utf8'))));
        } catch {}
      } else if (opcode === 8) {
        this.close();
        return;
      }
    }
  }
}
