/*
 * @Author: nevin
 * @Date: 2025-02-21 21:10:01
 * @LastEditTime: 2025-02-21 21:12:28
 * @LastEditors: nevin
 * @Description: 存储
 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import Store from 'electron-store';

// 固定用户数据目录为 %APPDATA%\zhiyin：
// 安装、卸载、升级三条链路永远读写同一个目录，保证老数据无缝衔接；
// 即使将来产品改名或安装目录变化，也不会再把数据“搬家”导致失联。
// 必须在实例化 electron-store 之前执行（本模块是唯一存储实例）。
const USER_DATA_DIR_NAME = 'zhiyin';
const pinnedUserData = path.join(app.getPath('appData'), USER_DATA_DIR_NAME);
if (app.getPath('userData') !== pinnedUserData) {
  app.setPath('userData', pinnedUserData);
}

export const store: any = new Store();
// 定义ipcRenderer监听事件
ipcMain.handle('setStore', (_, key, value) => {
  store.set(key, value);
});
ipcMain.handle('getStore', async (_, key) => {
  const value = store.get(key);
  return value || '';
});
