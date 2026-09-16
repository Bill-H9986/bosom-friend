/*
 * @Author: nevin
 * @Date: 2025-02-10 22:20:15
 * @LastEditTime: 2025-02-22 19:21:08
 * @LastEditors: nevin
 * @Description: 日志组件
 */
import * as path from 'path';
import { app, ipcMain } from 'electron';
import fs from 'fs';

import log from 'electron-log/main';

// 创建logs目录并配置日志路径
const logDirectory = path.join(app.getPath('userData'), 'logs');

log.transports.file.level = 'info';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
log.transports.file.resolvePathFn = () => {
  return path.join(
    logDirectory,
    `${new Date().toISOString().slice(0, 10)}.log`,
  );
}; // 按天生成日志

log.initialize();

// stdout/stderr 管道可能被宿主进程关闭（如开发 harness 重启、终端关闭），
// 底层 EPIPE 异常会经 electron-log 的 console transport 触发「写日志→报错→
// 再写日志」死循环刷屏。这里吞掉 EPIPE（按 Node 惯例返回 false 表示背压），
// 日志仍完整落盘到文件传输层，不影响任何功能。
const stdoutWrite = process.stdout.write.bind(process.stdout);
const stderrWrite = process.stderr.write.bind(process.stderr);
function safePipeWrite(write: typeof stdoutWrite) {
  return (chunk: any, ...args: any[]) => {
    try {
      return write(chunk, ...args);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EPIPE') {
        return false;
      }
      throw error;
    }
  };
}
process.stdout.write = safePipeWrite(stdoutWrite) as typeof process.stdout.write;
process.stderr.write = safePipeWrite(stderrWrite) as typeof process.stderr.write;

// 异步 EPIPE/ECONNRESET 通过 stream error 事件抛出（同步 try/catch 拦不住），
// 未监听会成为 uncaughtException。这里吞掉，日志仍完整落盘到文件传输层。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {});
}

console.log = log.log;
console.error = log.error;
console.info = log.info;
console.warn = log.warn;
console.debug = log.debug;

export const logger = log;

export default log;

// 导出路径
export const logPath = logDirectory;

/**
 * 获取近N天的文件路径列表
 * @param days
 * @returns
 */
export function getLogFilePaths(days: number): string[] {
  const logFiles = fs.readdirSync(logDirectory);
  const logFilePaths = logFiles
    .filter((file) => file.endsWith('.log'))
    .map((file) => path.join(logDirectory, file))
    .filter((filePath) => {
      const fileStat = fs.statSync(filePath);
      const fileDate = new Date(fileStat.mtime);
      return fileDate >= new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    });

  return logFilePaths;
}

/**
 * 清理一周前的日志
 */
export function clearOldLogs() {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const logFiles = fs.readdirSync(logDirectory);
  const logFilePaths = logFiles
    .filter((file) => file.endsWith('.log'))
    .map((file) => path.join(logDirectory, file))
    .filter((filePath) => {
      const fileStat = fs.statSync(filePath);
      return fileStat.mtime.getTime() < oneWeekAgo;
    });

  logFilePaths.forEach((filePath) => {
    fs.unlinkSync(filePath);
  });
}

/**
 * 获取日志文件列表
 */
ipcMain.handle('GLOBAL_LOG_GET_FLIES', async (event, days) => {
  const res = getLogFilePaths(days || 7);
  return res;
});
