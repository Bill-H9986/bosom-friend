/*
 * @Author: nevin
 * @Date: 2025-01-20 22:02:54
 * @LastEditTime: 2025-02-19 22:08:57
 * @LastEditors: nevin
 * @Description:
 */
import { Controller, Et, Icp, Inject } from '../core/decorators';
import { AccountService } from './service';
import { getUserInfo } from '../user/comment';
import platController from '../plat';
import type { ICreateBrowserWindowParams } from './BrowserWindow/browserWindow';
import { browserWindowController } from './BrowserWindow';
import { AccountStatus, PlatType } from '../../../commont/AccountEnum';
import { AccountModel } from '../../db/models/account';
import windowOperate from '../../util/windowOperate';
import { SendChannelEnum } from '../../../commont/UtilsEnum';
import { cancelPlatformLogin, clearPlatformSession, openPlatformLogin, serializeLoginCookies } from '../plat/platformLogin';
import { clearDouyinAutoSession, ensureDouyinAutoWindow, readDouyinSecurityToken } from '../plat/autoDouyinWindow';
import { configureDouyinCloudAuth, pollDouyinCloudAuthResult, completeLocalAuthSession } from '../plat/douyinCloudAuth';
import { logger } from '../../global/log';
import { AccountGroupModel } from '../../db/models/accountGroup';
import { proxyCheck } from '../../plat/coomont';
import { container } from '../core/container';
import { getBackendBase } from '../config/backendBase';

/** 随包后端可能仍在后台启动；落库前等网关就绪，避免登录成功却因 DB 未起报错 */
async function waitForBackendReady(timeoutMs = 120_000): Promise<void> {
  const base = getBackendBase();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    }
    catch {
      // 网络未就绪，继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

@Controller()
export class AccountController {
  @Inject(AccountService)
  private readonly accountService!: AccountService;

  // 创建浏览器视图
  @Icp('ICP_ACCOUNT_CREATE_BROWSER_VIEW')
  async createBrowserView(
    event: Electron.IpcMainInvokeEvent,
    data: ICreateBrowserWindowParams,
  ): Promise<void> {
    await browserWindowController.createBrowserWindow(data);
  }

  // 销毁浏览器视图
  @Icp('ICP_ACCOUNT_DESTROY_BROWSER_VIEW')
  async destroyBrowserView(
    event: Electron.IpcMainInvokeEvent,
    webViewId: number,
  ): Promise<void> {
    browserWindowController.destroyBrowserWindow(webViewId);
  }

  /**
   * 登录三方平台
   */
  @Icp('ICP_ACCOUNT_LOGIN')
  async accountLogin(
    event: Electron.IpcMainInvokeEvent,
    pType: PlatType,
  ): Promise<any> {
    await waitForBackendReady();
    const userInfo = getUserInfo();

    const accountInfo = await platController.platlogin(pType);
    if (!accountInfo) return null;

    accountInfo.status = AccountStatus.USABLE;
    accountInfo.userId = userInfo.id;

    const account = await this.accountService.addOrUpdateAccount(
      {
        userId: userInfo.id,
        type: pType,
        uid: accountInfo?.uid || '',
      },
      accountInfo,
    );
    windowOperate.sendRenderMsg(SendChannelEnum.AccountLoginFinish, account);
    // 保存账户信息
    return account;
  }

  /**
   * 取消三方平台登录：关闭登录窗口并结束等待
   */
  @Icp('ICP_ACCOUNT_LOGIN_CANCEL')
  async cancelAccountLogin(
    _event: Electron.IpcMainInvokeEvent,
    pType: PlatType,
  ): Promise<boolean> {
    // 官方插件式登录窗口 + 旧登录窗口两条链路都取消
    cancelPlatformLogin(pType);
    platController.cancelLogin(pType);
    return true;
  }

  /**
   * 官方插件式登录：打开平台创作者页，用户网页登录后自动检测并保存账号
   */
  @Icp('ICP_PLATFORM_LOGIN_OPEN')
  async platformLoginOpen(
    _event: Electron.IpcMainInvokeEvent,
    pType: PlatType,
  ): Promise<AccountModel | null> {
    await waitForBackendReady();
    const userInfo = getUserInfo();

    const cookies = await openPlatformLogin(pType);
    if (!cookies) {
      return null;
    }

    logger.info('[platform-login] 会话获取成功，开始同步账号:', pType);
    await waitForBackendReady();
    const loginCookie = serializeLoginCookies(cookies);

    // 账号信息拉取：
    // - xhs 已切换 Node fetch 传输（可正常读接口），同步时拉取昵称/头像/粉丝；
    // - douyin/wxSph 的 getUserInfo 仍走 net.request（douyin 可用；wxSph 接口暂不可达），失败用占位信息；
    // 统一 8 秒超时兜底，同步流程不被拖死。
    const accountInfo: Record<string, unknown> = { loginCookie };
    // 登录成功即回填平台真实账号信息（xhs/douyin 读接口均已打通）；
    // 拉取失败用占位信息兜底（账号不丢失，后续周期刷新可补真实值）
    if (pType === PlatType.Xhs || pType === PlatType.Douyin) {
      try {
        const info = await Promise.race([
          platController.getPlatformAccountInfo(pType, JSON.parse(loginCookie)),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
        ]);
        if (info) {
          Object.assign(accountInfo, info, { loginCookie });
        }
      }
      catch {
        // 忽略：占位信息保证账号入列表
      }
    }

    // uid 为空时使用合成值兜底：账号信息拉取失败也不能让账号丢失（后续可刷新）
    const uid = (accountInfo.uid as string) || `${pType}_${Date.now()}`;

    // 平台类型必须显式设置：信息拉取失败时也不能为空（避免同平台匹配逻辑误伤其他账号）
    accountInfo.type = pType;
    accountInfo.status = AccountStatus.USABLE;
    accountInfo.userId = userInfo?.id || '';
    accountInfo.uid = uid;
    accountInfo.account = (accountInfo.account as string) || uid;
    accountInfo.avatar = (accountInfo.avatar as string) ?? '';
    accountInfo.nickname = (accountInfo.nickname as string) || `${pType} 账号`;

    const account = await this.accountService.addOrUpdateAccount(
      {
        userId: userInfo.id,
        type: pType,
        uid,
      },
      accountInfo as Partial<AccountModel>,
    );

    if (pType === PlatType.Douyin && account) {
      // 登录成功后立即重建常驻自动窗口：评论接待/私信接待/作品采集三条
      // CDP 页面驱动都依赖该窗口（此前首登后不重建，三条链路全部找不到窗口）
      const autoWin = await ensureDouyinAutoWindow();
      if (autoWin && !autoWin.isDestroyed()) {
        // 读取安全令牌（privateKey/webProtect）落盘：发布链路 bd-ticket 依赖
        const token = await readDouyinSecurityToken(autoWin);
        if (token) {
          await this.accountService.addOrUpdateAccount(
            { userId: userInfo.id, type: pType, uid },
            { token } as Partial<AccountModel>,
          );
          logger.info('[platform-login] 抖音安全令牌已落盘');
        }
      }
    }

    // 登录成功后延迟触发一次作品数据采集并上报后端：数据概览无需等周期同步，
    // 平台历史作品（含手动发布、未经过本端发布的作品）立即可见。
    // 延迟 15 秒等平台登录态稳定、创作页窗口加载完成。
    if (
      account
      && (pType === PlatType.Douyin
        || pType === PlatType.Xhs
        || pType === PlatType.WxSph)
    ) {
      setTimeout(() => {
        void (
          container.getController('PublishController') as {
            syncPublishRecordsToBackend: () => Promise<unknown>;
          }
        )
          .syncPublishRecordsToBackend()
          .catch((e) => {
            logger.error('[platform-login] 登录后作品数据同步失败:', e);
          });
      }, 15000);
    }

    logger.info('[platform-login] 账号已同步:', pType, account && account.id);
    windowOperate.sendRenderMsg(SendChannelEnum.AccountLoginFinish, account);
    return account;
  }

  /**
   * 抖音小程序云端授权轮询：小程序扫码授权后，云函数在服务端完成 ticket 兑换
   * 并落库，这里轮询云函数 HTTP 触发器结果并回填本地后端授权回调，
   * 实现「小程序 → 云端兑换 → 桌面端轮询 → 本地绑定」全链路（无需公网服务器）。
   */
  @Icp('ICP_DOUYIN_CLOUD_AUTH_POLL')
  async douyinCloudAuthPoll(
    _event: Electron.IpcMainInvokeEvent,
    payload: { state: string; triggerUrl?: string; gatewayBase?: string },
  ): Promise<{ ok: boolean; result?: unknown; done?: unknown }> {
    if (!payload?.state) return { ok: false };
    if (payload.triggerUrl) configureDouyinCloudAuth(payload.triggerUrl);
    const result = await pollDouyinCloudAuthResult(payload.state, 180000);
    if (!result) return { ok: false };
    const gateway = payload.gatewayBase || 'http://127.0.0.1:3080/bosom-friend/api';
    const done = await completeLocalAuthSession(gateway, {
      state: payload.state,
      token: String(result.access_token ?? result.token ?? ''),
      nickname: result.nickname,
      avatar: result.avatar,
      tickets: result.tickets ?? {},
    }).catch((e) => ({ error: String(e) }));
    return { ok: true, result, done };
  }

  /**
   * 退出平台账号：删除账号并清理该平台的浏览器会话（官方插件式退出）
   */
  @Icp('ICP_PLATFORM_ACCOUNT_LOGOUT')
  async platformAccountLogout(
    _event: Electron.IpcMainInvokeEvent,
    accountId: number,
    pType: PlatType,
  ): Promise<boolean> {
    const userInfo = getUserInfo();
    await this.accountService.deleteAccounts([accountId], userInfo.id);
    // 官方插件式退出：douyin 关闭常驻窗口；其余平台按域清理共享分区内的登录会话
    if (pType === PlatType.Douyin) {
      await clearDouyinAutoSession();
    }
    else {
      await clearPlatformSession(pType);
    }
    return true;
  }

  /**
   * 账户登录检测-单个
   */
  @Icp('ICP_ACCOUNT_LOGIN_CHECK')
  async checkAccountLogin(
    event: Electron.IpcMainInvokeEvent,
    pType: PlatType,
    uid: string,
    isSendEvent: boolean = true,
  ): Promise<AccountModel | null> {
    const account = await this.accountService.checkAccountLoginCore(pType, uid);
    if (isSendEvent) {
      windowOperate.sendRenderMsg(SendChannelEnum.AccountLoginFinish, account);
    }
    return account;
  }

  /**
   * 账户登录检测-多个
   */
  @Icp('ICP_ACCOUNT_LOGIN_CHECK_MULTI')
  async checkAccountLoginMulti(
    event: Electron.IpcMainInvokeEvent,
    checkAccounts: {
      pType: PlatType;
      uid: string;
    }[],
  ): Promise<(AccountModel | null)[]> {
    const tasks: Promise<AccountModel | null>[] = [];

    for (const { pType, uid } of checkAccounts) {
      tasks.push(this.accountService.checkAccountLoginCore(pType, uid));
    }
    const accounts = await Promise.all(tasks);
    windowOperate.sendRenderMsg(
      SendChannelEnum.AccountLoginFinish,
      accounts[0],
      accounts,
    );
    return accounts;
  }

  // 更新用户状态
  @Icp('ICP_ACCOUNT_UPDATE_STATUS')
  async updateAccountStatus(
    event: Electron.IpcMainInvokeEvent,
    // 账户ID
    id: number,
    status: AccountStatus,
  ) {
    return this.accountService.updateAccountStatus(id, status);
  }

  // 获取账户信息
  @Icp('ICP_ACCOUNT_GET_INFO')
  async getAccountInfo(
    event: Electron.IpcMainInvokeEvent,
    data: { type: PlatType; uid: string },
  ): Promise<any> {
    const userInfo = getUserInfo();

    const { type, uid } = data;

    const accountInfo = await this.accountService.getAccountInfo({
      type,
      userId: userInfo.id,
      uid,
    });

    // console.log('userInfouserInfo@@@:', accountInfo);

    return accountInfo;
  }

  // 获取账户列表
  @Icp('ICP_ACCOUNT_GET_LIST')
  async getAccountList(event: Electron.IpcMainInvokeEvent): Promise<any> {
    const userInfo = getUserInfo();
    return this.accountService.getAccounts(userInfo.id);
  }

  // 获取账户列表(ids)
  @Icp('ICP_ACCOUNT_GET_LIST_BY_IDS')
  async getAccountListByIdsTcp(
    event: Electron.IpcMainInvokeEvent,
    ids: number[],
  ): Promise<any> {
    return this.getAccountListByIds(ids);
  }
  // 获取账户列表(ids)
  @Et('ET_ACCOUNT_GET_LIST_BY_IDS')
  async getAccountListByIdsEt(
    ids: number[],
    callback: (p: AccountModel[]) => void,
  ): Promise<any> {
    const accounts = await this.getAccountListByIds(ids);
    callback(accounts);
  }
  async getAccountListByIds(ids: number[]) {
    const userInfo = getUserInfo();
    if (!userInfo?.id) return [];
    return this.accountService.getAccountListByIds(userInfo.id, ids);
  }

  // 获取账户总数
  @Icp('ICP_ACCOUNT_GET_COUNT')
  async getAccountCount(event: Electron.IpcMainInvokeEvent): Promise<any> {
    const userInfo = getUserInfo();
    return this.accountService.getAccountCount(userInfo.id);
  }

  // 获取账户统计
  @Icp('ICP_ACCOUNT_STATISTICS')
  async getAccountStatistics(
    event: Electron.IpcMainInvokeEvent,
    type?: PlatType,
  ): Promise<any> {
    const userInfo = getUserInfo();
    return this.accountService.getAccountStatistics(userInfo.id, type);
  }

  // 获取账户的看板数据
  @Icp('ICP_ACCOUNT_DASHBOARD')
  async getDashboard(
    event: Electron.IpcMainInvokeEvent,
    id: number,
    time?: any,
  ) {
    if (!id) return null;

    const account = await this.accountService.getAccountById(id);
    if (!account) return null;
    return this.accountService.getAccountDashboard(account, time);
  }

  // 删除账户
  @Icp('ICP_ACCOUNTS_DELETE')
  async deleteAccount(
    event: Electron.IpcMainInvokeEvent,
    ids: number[],
  ): Promise<any> {
    const userInfo = getUserInfo();
    return this.accountService.deleteAccounts(ids, userInfo.id);
  }

  // 修改账户的账户组
  @Icp('ICP_ACCOUNTS_EDIT_GROUP')
  async accountEditGroup(
    event: Electron.IpcMainInvokeEvent,
    id: number,
    groupId: number,
  ): Promise<any> {
    return this.accountService.updateAccountInfo(id, {
      groupId,
    });
  }

  // 添加用户组数据
  @Icp('ICP_ACCOUNTS_GROUP_ADD')
  async addAccountGroup(
    event: Electron.IpcMainInvokeEvent,
    data: Partial<AccountGroupModel>,
  ): Promise<any> {
    return this.accountService.addAccountGroup(data);
  }
  // 获取用户组数据
  @Icp('ICP_ACCOUNTS_GROUP_GET')
  async getAccountGroup(event: Electron.IpcMainInvokeEvent): Promise<any> {
    return this.accountService.getAccountGroup();
  }
  // 删除用户组数据
  @Icp('ICP_ACCOUNTS_GROUP_DELETE')
  async deleteAccountGroup(
    event: Electron.IpcMainInvokeEvent,
    id: number,
  ): Promise<any> {
    return this.accountService.deleteAccountGroup(id);
  }
  // 编辑用户组数据
  @Icp('ICP_ACCOUNTS_GROUP_EDIT')
  async editAccountGroup(
    event: Electron.IpcMainInvokeEvent,
    data: Partial<AccountGroupModel>,
  ): Promise<any> {
    return this.accountService.editAccountGroup(data);
  }

  // 代理地址有效性检测
  @Icp('ICP_ACCOUNTS_PROXY_CHECK')
  async proxyCheck(
    event: Electron.IpcMainInvokeEvent,
    proxy: string,
  ): Promise<any> {
    return await proxyCheck(proxy);
  }

  @Et('ET_UP_ALL_ACCOUNT_STATISTICS') // 更新所有的账户的统计信息
  async updateAllAccountStatistics(id: number, status: number) {
    const userInfo = getUserInfo();

    const allAccountList = await this.accountService.getAccounts(userInfo.id);
    for (const element of allAccountList) {
      this.accountService.updateAccountStatistics(
        element.id!,
        element.fansCount,
        element.readCount,
        element.likeCount,
        element.collectCount,
        element.commentCount,
        element.income!,
      );
    }
    await this.accountService.updateAccountStatus(id, status);
  }
}
