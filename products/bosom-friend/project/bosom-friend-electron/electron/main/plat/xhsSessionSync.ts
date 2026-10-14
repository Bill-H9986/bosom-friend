/**
 * 小红书会话轮换同步
 *
 * 背景：小红书平台会在登录/创作页流程中轮换 web_session cookie；
 * 分区（persist:zhiyin-douyin-auto）里是最新值，而账号记录的 loginCookie 还是旧值，
 * 导致主进程直连接口全部 401 无登录信息。本模块把分区最新会话回写账号记录，
 * 保证发布/作品/评论/私信链路始终使用新鲜会话。
 */
import { session } from 'electron';
import { logger } from '../../global/log';
import { xiaohongshuService } from '../../plat/xiaohongshu';
import { AppDataSource } from '../../db';
import { AccountModel } from '../../db/models/account';
import { PlatType } from '../../../commont/AccountEnum';

const PLAT_PARTITION = 'persist:zhiyin-xhs';

/**
 * 用共享分区的最新小红书会话刷新账号 loginCookie。
 * 返回 true 表示发生了轮换同步。
 */
export async function refreshXhsAccountCookie(
  target?: AccountModel,
): Promise<boolean> {
  try {
    const ses = session.fromPartition(PLAT_PARTITION);
    const cookies = await ses.cookies.get({});
    const xhsCookies = cookies.filter((c) =>
      c.domain?.includes('xiaohongshu.com'),
    );
    if (!xhsCookies.some((c) => c.name === 'web_session' && c.value)) {
      return false;
    }
    const nextCookie = JSON.stringify(xhsCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    })));

    const repo = AppDataSource.getRepository(AccountModel);
    const account =
      target ??
      (await repo.findOne({ where: { type: PlatType.Xhs as any } }));
    if (!account) return false;
    if (account.loginCookie === nextCookie) return false;

    // 身份一致性防护：账号已持有真实 authorId 时，先核对分区会话身份，
    // 换号/过期后分区里是别的账号时禁止回写，避免 A 账号 cookie 覆盖到 B 账号；
    // 账号还是合成 uid 时顺便回填真实 authorId/昵称/粉丝（无需重新登录）
    const isSyntheticUid = /^xhs_\d+$/.test(account.uid || '');
    const identity = await xiaohongshuService
      .getUserInfo(xhsCookies)
      .catch(() => null);
    if (identity?.authorId) {
      if (!isSyntheticUid && identity.authorId !== account.uid) {
        logger.warn(
          '[xhs-session-sync] 分区会话身份与账号不一致，跳过回写: 分区=' ,
          identity.authorId,
          '账号=',
          account.uid,
        );
        return false;
      }
      if (isSyntheticUid) {
        account.uid = identity.authorId;
        account.account = identity.authorId;
        if (identity.nickname) account.nickname = identity.nickname;
        if (identity.avatar) account.avatar = identity.avatar;
        if (identity.fansCount != null) account.fansCount = identity.fansCount;
        logger.info('[xhs-session-sync] 账号合成 uid 已回填真实 authorId:', identity.authorId);
      }
    }

    account.loginCookie = nextCookie;
    await repo.save(account);
    logger.info('[xhs-session-sync] 已用共享分区最新会话刷新账号 cookie');
    return true;
  } catch (e) {
    logger.error('[xhs-session-sync] 刷新账号 cookie 失败:', e);
    return false;
  }
}
