// [slim] 操作埋点已移除，空实现
const collectOperationMetrics: any = (..._a: unknown[]): void => {};
/*
 * @Author: nevin
 * @Date: 2025-01-20 22:02:54
 * @LastEditTime: 2025-02-06 19:14:12
 * @LastEditors: nevin
 * @Description:
 */
import { Controller, Icp, Inject } from '../core/decorators';
import { UserService } from './service';
import { UserModel } from '../../db/models/user';
import { clearDouyinAutoSession } from '../plat/autoDouyinWindow';
import { store } from '../../global/store';
import { logger } from '../../global/log';

@Controller()
export class UserController {
  @Inject(UserService)
  private readonly userService!: UserService;

  /**
   * 添加用户
   */
  @Icp('ICP_USER_ADD')
  async addUser(
    event: Electron.IpcMainInvokeEvent,
    user: UserModel,
  ): Promise<UserModel> {
    const currUser = {
      ...user,
      phone: user.phone || user.wxOpenId,
      loginTime: new Date(),
    };
    await this.userService.addUser(currUser);
    return currUser;
  }

  /**
   * 获取平台存储的所有用户信息
   */
  @Icp('ICP_USER_ALL')
  async getUserList(): Promise<UserModel[]> {
    return await this.userService.getUsers();
  }

  /**
   * 用户退出登录：清理主进程侧平台会话（抖音自动化窗口持久分区等），
   * 并清除持久化登录态（electron-store 'store-user'）——否则重启后会被
   * 自动登录 token 注入重新拉回登录态，退出失效。
   */
  @Icp('ICP_USER_LOGOUT')
  async userLogout(): Promise<boolean> {
    try {
      store.set('store-user', '')
    } catch (e) {
      logger.warn('[user-logout] 清除持久化登录态失败:', e)
    }
    await clearDouyinAutoSession();
    return true;
  }

  /**
   * 运营指标：发布成功率 / 账号健康 / 数据采集覆盖率（商用平台运营看板消费）
   */
  @Icp('ICP_OPERATION_METRICS')
  async operationMetrics(): Promise<ReturnType<typeof collectOperationMetrics>> {
    return collectOperationMetrics();
  }
}
