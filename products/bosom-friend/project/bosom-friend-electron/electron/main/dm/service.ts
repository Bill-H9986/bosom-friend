/*
 * 私信自动接待服务：轮询抖音私信 → 后端接待规则匹配 → AI 生成回复 → 发送 → 记录
 */
import { getBackendBase } from '../config/backendBase'
import { logger } from '../../global/log'
import { Injectable, Inject } from '../core/decorators';
import { Repository } from 'typeorm';
import { AppDataSource } from '../../db';
import { DmReplyRecordModel } from '../../db/models/dmReplyRecord';
import { DmConversationModel } from '../../db/models/dmConversation';
import { AccountModel } from '../../db/models/account';
import { AccountService } from '../account/service';
import { getUserInfo, getUserToken } from '../user/comment';
import { DouyinImClient } from './douyin-im';
import { XhsImClient } from './xhs-im';
import {
  sendDmViaPage,
  readDmLatestViaPage,
  listDmConversationsViaPage,
} from './douyinImPageDriver';
import { PlatType } from '../../../commont/AccountEnum';
import { riskManager, randomRange, isRiskResponse } from '../safety/riskManager';
import { quotaManager } from '../safety/quotaManager';
import { checkContent } from '../safety/contentFilter';
import {
  refreshDouyinAccountCookie,
} from '../plat/autoDouyinWindow';
import { refreshXhsAccountCookie } from '../plat/xhsSessionSync';
import { douyinService } from '../../plat/douyin';
import { isDouyinSessionValid } from '../safety/sessionGuard';
import { sleep } from '../../util/time';
import { appendAutoLog } from '../knowledge/autoLog';
import { decideReception } from '../zhiyin/legacy-decision';
import { getKernelRuntime } from '../zhiyin-kernel-host';

// 人类化节奏：轮询间隔在 18~35 秒之间随机，避免固定频率被识别为机器
const POLL_INTERVAL_MIN_MS = 18 * 1000;
const POLL_INTERVAL_MAX_MS = 35 * 1000;
const BACKEND_BASE = getBackendBase()
const myUidCache = new Map<number, string>();
const mySecUidCache = new Map<number, string>();
/** 页面驱动冷却：API 失效时避免高频操作浏览器窗口触发风控 */
const pageDriverCooldown = new Map<number, number>();
const PAGE_DRIVER_COOLDOWN_MS = 5 * 60 * 1000;

function canUsePageDriver(accountId: number): boolean {
  const last = pageDriverCooldown.get(accountId) || 0;
  if (Date.now() - last < PAGE_DRIVER_COOLDOWN_MS) return false;
  pageDriverCooldown.set(accountId, Date.now());
  return true;
}

@Injectable()
export class DmReceptionService {
  private dmReplyRecordRepository: Repository<DmReplyRecordModel>;
  private dmConversationRepository: Repository<DmConversationModel>;
  private timer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private enabled = false;
  private polling = false;
  private pollRoundToken = 0;
  private lastPollAt: number | null = null;
  private lastRound: {
    accounts: number;
    conversations: number;
    replied: number;
    at: number;
  } | null = null;

  constructor() {
    this.dmReplyRecordRepository = AppDataSource.getRepository(DmReplyRecordModel);
    this.dmConversationRepository = AppDataSource.getRepository(DmConversationModel);
    // 7x24 全自动接待：应用启动即运行，无需开关
    this.enabled = true;
    this.startTimer();
  }

  /** 成功接待同步写回内核统一数据层 */
  private mirrorKernelDm(input: {
    accountId: number;
    platform: string;
    sourceId: string;
    peerName?: string;
    message: string;
    reply: string;
  }): void {
    getKernelRuntime()?.recordInteraction({
      id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'dm',
      platform: input.platform,
      accountId: input.accountId,
      sourceId: input.sourceId,
      peerName: input.peerName,
      content: input.message,
      reply: input.reply,
      repliedAt: new Date().toISOString(),
      status: 'replied',
    });
  }

  @Inject(AccountService)
  private readonly accountService!: AccountService;

  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    // 自动接待为平台核心能力，常驻开启，忽略关闭请求
    this.enabled = true;
    this.startTimer();
    this.pollAll().catch((e) => {
      logger.error('[dm-reception] 启动轮询出错', e);
    });
    return { enabled };
  }

  private startTimer() {
    if (this.scheduleTimer) return;
    const scheduleNext = () => {
      const delay = randomRange(POLL_INTERVAL_MIN_MS, POLL_INTERVAL_MAX_MS);
      // 调度链与单轮执行解耦：即使单轮卡死，下一轮照常触发，
      // 配合看门狗强制复位轮询锁，杜绝私信接待整链停摆。
      this.scheduleTimer = setTimeout(() => {
        void this.runPollRound();
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  /**
   * 单轮私信轮询：看门狗兜底，超时强制复位轮询锁。
   * 轮次令牌：旧轮超时被新轮取代后自行退出，避免两轮并发操作同一窗口。
   */
  private async runPollRound() {
    const round = ++this.pollRoundToken;
    let watchdog: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.pollAll(round),
        new Promise<void>((resolve) => {
          watchdog = setTimeout(() => {
            logger.error('[dm-reception] 私信轮询单轮超时（>5分钟），强制复位轮询锁');
            this.polling = false;
            resolve();
          }, 5 * 60 * 1000);
        }),
      ]);
    } catch (e) {
      logger.error('[dm-reception] 定时轮询出错', e);
    } finally {
      // 轮次正常结束必须清理看门狗定时器，否则 5 分钟后定时器照常触发，
      // 刷出虚假「单轮超时」日志并误复位轮询锁
      if (watchdog) clearTimeout(watchdog);
      // 仅最新一轮复位锁：旧轮的 finally 不得放行新轮
      if (round === this.pollRoundToken) {
        this.polling = false;
      }
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      lastPollAt: this.lastPollAt,
      polling: this.polling,
      lastRound: this.lastRound,
    };
  }

  /**
   * 轮询所有抖音账号的私信
   */
  async pollAll(round?: number): Promise<{ accounts: number; conversations: number; replied: number }> {
    if (this.polling) {
      return { accounts: 0, conversations: 0, replied: 0 };
    }
    this.polling = true;
    let accountCount = 0;
    let convCount = 0;
    let replyCount = 0;
    try {
      // 已超时被新轮取代：自行退出，避免并发操作同一窗口
      if (round != null && round !== this.pollRoundToken) {
        return { accounts: 0, conversations: 0, replied: 0 };
      }
      const accounts = await this.accountService.getAccounts();
      // 私信走独立的 imapi 通道，不依赖账号的"登录状态"门禁（该状态会被 creator 平台登录检查误判连坐）
      const douyinAccounts = accounts.filter(
        (a) => a.type === PlatType.Douyin && a.loginCookie,
      );
      let accountIndex = 0;
      for (const account of douyinAccounts) {
        // 多账号错峰：除第一个账号外，账号之间随机延迟 15~45 秒，
        // 避免多个账号在同一时刻操作平台，降低并发风控风险（对齐评论轮询策略）
        if (accountIndex++ > 0) {
          logger.info(
            '[dm-reception] 账号间错峰等待',
            Math.round(randomRange(15, 45)),
            '秒后处理下一个账号',
          );
          await sleep(randomRange(15, 45) * 1000);
        }
        // 风控冷却中的账号自动跳过，不发起任何请求
        const risk = riskManager.canOperate('douyin', account.id);
        if (!risk.ok) {
          logger.info(
            '[dm-reception] 账号',
            account.id,
            '处于风控冷却期，跳过本轮轮询',
            risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
              ? `还需 ${Math.ceil((risk.waitMs || 0) / 60000)} 分钟`
              : '（严重风控，需人工处理）',
          );
          continue;
        }
        accountCount++;
        const r = await this.pollAccount(account);
        convCount += r.conversations;
        replyCount += r.replied;
      }
      // 小红书私信：API 直连（X-S/X-T 签名通道），登录后自动接入 7×24 接待
      const xhsAccounts = accounts.filter(
        (a) => a.type === PlatType.Xhs && a.loginCookie,
      );
      for (const account of xhsAccounts) {
        if (accountIndex++ > 0) {
          await sleep(randomRange(15, 45) * 1000);
        }
        const risk = riskManager.canOperate('xhs', account.id);
        if (!risk.ok) {
          logger.info('[dm-reception] 小红书账号', account.id, '风控冷却中，跳过私信轮询');
          continue;
        }
        accountCount++;
        const r = await this.pollXhsAccount(account);
        convCount += r.conversations;
        replyCount += r.replied;
      }
      this.lastPollAt = Date.now();
      this.lastRound = {
        accounts: accountCount,
        conversations: convCount,
        replied: replyCount,
        at: Date.now(),
      };
    } finally {
      this.polling = false;
    }
    return { accounts: accountCount, conversations: convCount, replied: replyCount };
  }

  private async pollAccount(account: AccountModel): Promise<{ conversations: number; replied: number }> {
      if (account.type === PlatType.Douyin) {
        await refreshDouyinAccountCookie(account);
        // 登录态：纯后台静默处理。会话失效仅跳过本轮，绝不弹任何窗口。
        const valid = await isDouyinSessionValid(account.id, account.loginCookie);
        if (!valid) {
          logger.info('[dm-reception] 抖音会话失效，本轮静默跳过（等待用户手动登录）', account.id);
          return { conversations: 0, replied: 0 };
        }
      }
    const client = new DouyinImClient(account);
    let conversations = 0;
    let replied = 0;
    try {
      // 1. 发现新会话（陌生人待接待列表），持久化后持续轮询
      const convs = await client.getConversations();
      for (const conv of convs) {
        if (!conv.conversationId || !conv.conversationShortId) continue;
        await this.upsertConversation(account.id, conv);
      }

      // 2. 轮询所有已发现会话（含老会话，覆盖二次私信）
      const knownConvs = await this.dmConversationRepository.find({
        where: { accountId: account.id },
      });
      for (const conv of knownConvs) {
        conversations++;
        const handled = await this.processConversation(client, account, {
          conversationId: conv.conversationId,
          conversationShortId: conv.conversationShortId,
          users: [],
        });
        if (handled) replied++;
      }

      // 3. 页面驱动发现新会话（imapi 通道失效时兜底，覆盖创作者后台可见的全部会话）
      if (canUsePageDriver(account.id)) {
        const pageConvs = await listDmConversationsViaPage();
        if (pageConvs.ok) {
          for (const pc of pageConvs.conversations) {
            if (!pc.peerName) continue;
            conversations++;
            const handled = await this.processPageConversation(account, pc.peerName);
            if (handled) replied++;
          }
        }
      }
    } catch (e) {
      logger.error('[dm-reception] 账号轮询出错', account.id, e);
    }
    return { conversations, replied };
  }

  /**
   * 小红书账号私信接待：会话列表 → 最新消息 → AI 决策 → 签名直连发送 → 落库去重
   * 自回复保护：用平台返回的本人 user_id 过滤自己发出的消息，防止自回复死循环；
   * 本人信息拿不到时整账号跳过（宁可漏接待，不可刷屏自回复）。
   */
  private async pollXhsAccount(
    account: AccountModel,
  ): Promise<{ conversations: number; replied: number }> {
    const client = new XhsImClient(account);
    let conversations = 0;
    let replied = 0;
    let selfUserId: string | null = null;
    try {
      // 会话轮换同步：平台轮换 web_session 后回写最新 cookie，避免 401 无登录信息
      await refreshXhsAccountCookie(account);
      // 自回复保护前置：拿不到本人 id 不进入发送链路
      selfUserId = await client.getSelfUserId();
      if (!selfUserId) {
        logger.info('[dm-reception] 小红书账号', account.id, '本人信息不可用（未登录），跳过私信接待');
        return { conversations: 0, replied: 0 };
      }

      let convs: Awaited<ReturnType<typeof client.getConversations>> = [];
      try {
        convs = await client.getConversations();
      } catch (e: any) {
        // 平台限权信号（-104 私信权限被收回等）：上报风控冷却，停止轮询，
        // 避免持续请求加重账号风控等级。
        if (e?.xhsImRisk) {
          riskManager.reportRisk(
            'xhs',
            account.id,
            '私信权限被平台收回: ' + String(e.message || e),
          );
          logger.info(
            '[dm-reception] 小红书账号',
            account.id,
            '私信被平台限权，进入风控冷却并停止本轮轮询',
          );
          return { conversations: 0, replied: 0 };
        }
        throw e;
      }      // 防骚扰保护：只接待最近 7 天内有新消息的会话，且每轮最多处理 10 个会话，
      // 避免私信链路打通后对历史会话批量回复造成刷屏与风控。
      const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
      const MAX_CONVS_PER_ROUND = 10;
      const now = Date.now();
      let processedConvs = 0;
      for (const conv of convs) {
        if (!conv.sessionId) continue;
        if (conv.lastMsgTime && now - conv.lastMsgTime > RECENT_WINDOW_MS) continue;
        if (processedConvs >= MAX_CONVS_PER_ROUND) break;
        conversations++;
        let msgs: Awaited<ReturnType<typeof client.getMessages>> = [];
        try {
          msgs = await client.getMessages(conv.sessionId);
        } catch (e: any) {
          if (e?.xhsImRisk) {
            riskManager.reportRisk(
              'xhs',
              account.id,
              '私信消息拉取被平台限权: ' + String(e.message || e),
            );
            logger.info('[dm-reception] 小红书账号', account.id, '私信消息拉取被限权，进入风控冷却');
            return { conversations, replied: 0 };
          }
          logger.error('[dm-reception] 小红书会话消息拉取失败', conv.sessionId, e);
          continue;
        }
        // 只处理对方发来的最新消息，且最多看最近 10 条，避免老消息重复接待
        const incoming = msgs
          .filter((m) => m.fromUserId && m.fromUserId !== selfUserId)
          .slice(-10);
        processedConvs++;
        for (const m of incoming) {
          // 只接待 7 天内的消息，防对历史会话批量回复
          if (m.time && Date.now() - m.time > RECENT_WINDOW_MS) continue;
          const dedupKey = 'xhs:' + conv.sessionId + ':' + m.id;
          const old = await this.dmReplyRecordRepository.findOne({
            where: { accountId: account.id, conversationShortId: dedupKey },
          });
          if (old) continue;

          const risk = riskManager.canOperate('xhs', account.id);
          if (!risk.ok) continue;
          const quota = quotaManager.canOperate('xhs', account.id, 'dm_reply');
          if (!quota.ok) {
            logger.info('[dm-reception] 小红书私信回复被配额限制:', quota.reason);
            continue;
          }

          const reply = await this.generateReply(account, m.content);
          if (!reply) continue;
          const contentCheck = checkContent(reply);
          if (!contentCheck.ok) {
            logger.info('[dm-reception] 小红书私信回复命中敏感词已拦截:', contentCheck.hitWords.join('、'));
            continue;
          }

          const sendRes = await client.sendMessage(conv.sessionId, reply);
          if (!sendRes.ok) {
            logger.info('[dm-reception] 小红书私信发送失败:', sendRes.msg || '');
            continue;
          }
          riskManager.reportSuccess('xhs', account.id);
          quotaManager.reportOperation('xhs', account.id, 'dm_reply');
          await this.dmReplyRecordRepository.save({
            userId: getUserInfo().id,
            accountId: account.id,
            type: PlatType.Xhs,
            conversationId: conv.sessionId,
            conversationShortId: dedupKey,
            serverMessageId: m.id || '',
            senderUid: m.fromUserId || '',
            senderName: m.fromNickname || conv.peerNickname || '',
            message: m.content,
            reply,
            status: 1,
          });
          this.mirrorKernelDm({
            accountId: account.id,
            platform: 'xhs',
            sourceId: m.id || `xhs-${Date.now()}`,
            peerName: m.fromNickname || conv.peerNickname || '',
            message: m.content,
            reply,
          });
          replied++;
          logger.info('[dm-reception] 小红书私信自动回复成功:', m.content.slice(0, 30));
          void appendAutoLog('私信自动回复', '小红书账号 ' + account.id + ' 已自动回复私信');
        }
      }
    } catch (e) {
      logger.error('[dm-reception] 小红书账号私信轮询出错', account.id, e);
    }
    return { conversations, replied };
  }

  /**
   * 页面驱动处理单个会话：读取最新消息 → AI 生成回复 → 页面驱动发送 → 落库去重
   */
  private async processPageConversation(
    account: AccountModel,
    peerName: string,
  ): Promise<boolean> {
    try {
      const pageRead = await readDmLatestViaPage(peerName);
      if (!pageRead.ok || !pageRead.messages.length) return false;
      const latest = pageRead.messages[pageRead.messages.length - 1];

      // 内容去重：5 分钟窗口内相同消息已回复则跳过
      const byText = await this.dmReplyRecordRepository.findOne({
        where: {
          accountId: account.id,
          type: PlatType.Douyin,
          message: latest.text,
        },
        order: { id: 'DESC' },
      });
      if (byText) {
        const dbTime = new Date(
          String(byText.createTime).replace(' ', 'T') + 'Z',
        ).getTime();
        if (Date.now() - dbTime < 5 * 60 * 1000) {
          logger.info('[dm-reception] 页面消息已回复过（内容+时间匹配），跳过:', latest.text.slice(0, 30));
          return false;
        }
      }

      // 风控与配额
      const risk = riskManager.canOperate('douyin', account.id);
      if (!risk.ok) {
        logger.info('[dm-reception] 风控冷却中，跳过页面会话', account.id);
        return false;
      }
      const quota = quotaManager.canOperate('douyin', account.id, 'dm_reply');
      if (!quota.ok) {
        logger.info('[dm-reception] 私信回复被配额限制:', quota.reason);
        return false;
      }

      // AI 生成回复
      const reply = await this.generateReply(account, latest.text);
      if (!reply) return false;
      const contentCheck = checkContent(reply);
      if (!contentCheck.ok) {
        logger.info('[dm-reception] 私信回复命中敏感词已拦截:', contentCheck.hitWords.join('、'));
        return false;
      }

      // 页面驱动发送
      const sendRes = await sendDmViaPage(peerName, reply);
      if (sendRes.ok) {
        riskManager.reportSuccess('douyin', account.id);
        quotaManager.reportOperation('douyin', account.id, 'dm_reply');
        await this.dmReplyRecordRepository.save({
          userId: getUserInfo().id,
          accountId: account.id,
          type: PlatType.Douyin,
          conversationId: '',
          conversationShortId: '',
          serverMessageId: latest.serverId,
          senderUid: '',
          senderName: peerName,
          message: latest.text,
          reply,
          status: 1,
        });
        this.mirrorKernelDm({
          accountId: account.id,
          platform: 'douyin',
          sourceId: latest.serverId,
          peerName,
          message: latest.text,
          reply,
        });
        logger.info('[dm-reception] 页面驱动私信回复成功:', latest.text.slice(0, 30));
        void appendAutoLog('私信自动回复', `抖音账号 ${account.id} 已自动回复私信`);
        return true;
      }
      logger.info('[dm-reception] 页面驱动私信回复失败:', sendRes.message || sendRes.status || '');
      return false;
    } catch (e) {
      logger.error('[dm-reception] 页面会话处理出错:', peerName, e);
      return false;
    }
  }

  private async upsertConversation(
    accountId: number,
    conv: { conversationId: string; conversationShortId: string; users: { userId?: string; secUid?: string }[] },
  ) {
    const existing = await this.dmConversationRepository.findOne({
      where: { accountId, conversationShortId: conv.conversationShortId },
    });
    if (existing) return;
    await this.dmConversationRepository.save({
      accountId,
      conversationId: conv.conversationId,
      conversationShortId: conv.conversationShortId,
    });
  }

  private async processConversation(
    client: DouyinImClient,
    account: AccountModel,
    conv: { conversationId: string; conversationShortId: string; users: { userId?: string; secUid?: string }[] },
  ): Promise<boolean> {
    try {
      let msgs: { serverId: string; senderUid?: string; senderSecUid?: string; text: string; createdAtUs?: string }[] = [];
      let apiBroken = false;
      try {
        const r = await client.getMessages(conv.conversationId, conv.conversationShortId);
        msgs = r.msgs;
        logger.info('[dm-reception][debug] 会话', conv.conversationShortId, '消息数', msgs.length);
      } catch (e) {
        apiBroken = true;
        logger.error('[dm-reception] imapi 读取失败，将切换页面驱动', account.id, e);
      }

      // 存在发送失败记录时，用页面驱动读取并补发（避免无谓消耗页面驱动冷却）
      const pendingFailed = await this.dmReplyRecordRepository.findOne({
        where: {
          accountId: account.id,
          conversationShortId: conv.conversationShortId,
          status: 0,
        },
        order: { id: 'DESC' },
      });
      if (pendingFailed && canUsePageDriver(account.id)) {
        const knownConv = await this.dmConversationRepository.findOne({
          where: { accountId: account.id, conversationShortId: conv.conversationShortId },
        });
        const peerName = knownConv?.peerName || '';
        const pageRead = await readDmLatestViaPage(peerName);
        logger.info(
          '[dm-reception][page-driver] 读取结果',
          pageRead.ok,
          pageRead.messages.length,
          pageRead.sessionInvalid ? '会话失效' : '',
        );
        if (pendingFailed) {
          if (pageRead.ok && pageRead.messages.length) {
            const pendingPrefix = (pendingFailed.message || '').slice(0, 10);
            const messageExists =
              pendingPrefix.length > 0 &&
              pageRead.messages.some((m) => m.text.includes(pendingPrefix));
            if (messageExists) {
              const reply = pendingFailed.reply || '';
              const sendRes = await sendDmViaPage(peerName, reply);
              logger.info(
                '[dm-reception][page-driver] 补发',
                sendRes.status,
                sendRes.message || '',
              );
              if (sendRes.ok) {
                await this.dmReplyRecordRepository.update(pendingFailed.id, {
                  status: 1,
                  updateTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
                });
                return true;
              }
              return false;
            }
          }
        }
      }

      if (!msgs.length) return false;

      // 解析会话双方身份，识别"自己"（unique_id 与账号 uid 一致）
      let myUid = myUidCache.get(account.id) || '';
      let otherName = '';
      let secUids: string[] = [];
      const knownConv = await this.dmConversationRepository.findOne({
        where: { accountId: account.id, conversationShortId: conv.conversationShortId },
      });
      if (myUid) {
        // 已识别过自身身份：直接复用本地缓存的访客信息，避免重复请求 profiles 接口
        otherName = knownConv?.peerName || '';
        if (knownConv?.peerSecUid) secUids = [knownConv.peerSecUid];
      } else {
        secUids = conv.users.map((u) => u.secUid).filter((s): s is string => !!s);
        for (const m of msgs) {
          if (m.senderSecUid && !secUids.includes(m.senderSecUid)) {
            secUids.push(m.senderSecUid);
          }
        }
        logger.info('[dm-reception][debug] secUids', JSON.stringify(secUids), 'cacheMyUid', myUid);
        if (!secUids.length) return false;
        const profiles = await client.resolveUsers(secUids);
        logger.info('[dm-reception][debug] profiles', JSON.stringify(profiles.map((p) => ({ uid: p.uid, uniqueId: p.uniqueId, nickname: p.nickname }))));
        // 自回复保护：识别"自己"必须用平台真实身份（sec_uid/unique_id），
        // account.uid 可能是合成占位值（douyin_<ts>），用它匹配会永远找不到自己
        // → myUid 恒空 → 私信回复整链路停摆
        const realMe = await douyinService.getUserInfo(JSON.parse(account.loginCookie)).catch(() => null);
        let me = profiles.find((u) => !!u.secUid && u.secUid === realMe?.uid);
        if (!me && realMe?.authorId) {
          me = profiles.find((u) => u.uniqueId === realMe.authorId || u.uid === realMe.authorId);
        }
        myUid = me?.uid || '';
        if (myUid) {
          myUidCache.set(account.id, myUid);
        }
        const meSec = me;
        if (meSec?.secUid) {
          mySecUidCache.set(account.id, meSec.secUid);
        }
        const other = profiles.find((u) => u.uid !== myUid);
        otherName = other?.nickname || '';
      }

      // 无法识别"自己"身份时跳过（避免误判消息方向）
      logger.info('[dm-reception][debug] myUid', myUid);
      if (!myUid) return false;

      // 更新会话的访客信息
      const otherSecUid = secUids.find((s) => s !== mySecUidCache.get(account.id));
      if (otherSecUid) {
        await this.dmConversationRepository.update(
          { accountId: account.id, conversationShortId: conv.conversationShortId },
          {
            peerSecUid: otherSecUid,
            peerName: otherName,
          },
        );
      }

      // 消息按 server_id 降序（页面驱动消息 ID 非数字，容错为 0 并保持原序）
      const serverNum = (s?: string): bigint => {
        try {
          return BigInt(s || '0');
        } catch {
          return 0n;
        }
      };
      const sorted = [...msgs].sort((a, b) => {
        const na = serverNum(a.serverId);
        const nb = serverNum(b.serverId);
        if (na !== nb) return na > nb ? -1 : 1;
        return 0;
      });
      const latestIncoming = sorted.find((m) => m.text && m.senderUid && m.senderUid !== myUid);
      logger.info('[dm-reception][debug] latestIncoming', JSON.stringify(latestIncoming ? { serverId: latestIncoming.serverId, senderUid: latestIncoming.senderUid, text: latestIncoming.text.slice(0, 30) } : null));
      if (!latestIncoming) return false;

      // 去重：已处理过该消息则跳过
      const handledRecord = await this.dmReplyRecordRepository.findOne({
        where: {
          accountId: account.id,
          conversationShortId: conv.conversationShortId,
          serverMessageId: latestIncoming.serverId,
        },
      });
      logger.info('[dm-reception][debug] handledRecord', handledRecord ? handledRecord.id : null);
      // 仅“已发送成功”的记录视为已处理；发送失败(status=0)的记录允许后续轮询重试补发
      if (handledRecord && handledRecord.status === 1) return false;

      // 若我们已在该消息之后回复过，跳过（避免重复回复）
      const repliedAfter = sorted.some(
        (m) =>
          m.senderUid === myUid &&
          serverNum(m.serverId) > serverNum(latestIncoming.serverId),
      );
      logger.info('[dm-reception][debug] repliedAfter', repliedAfter);
      if (repliedAfter) return false;

      // 后端接待规则匹配 + AI 生成 + 记录
      const reply = await this.generateReply(account, latestIncoming.text);
      logger.info('[dm-reception][debug] reply', reply ? reply.slice(0, 60) : null);
      if (!reply) return false;

      // 内容安全：AI 回复发送前过敏感词过滤，命中则放弃本次回复（合法合规底线）
      const contentCheck = checkContent(reply);
      if (!contentCheck.ok) {
        logger.info(
          '[dm-reception] 私信回复命中敏感词已拦截:',
          contentCheck.hitWords.join('、'),
        );
        return false;
      }

      // 操作配额检查：每日上限 / 最小间隔 / 突发熔断
      const quota = quotaManager.canOperate('douyin', account.id, 'dm_reply');
      if (!quota.ok) {
        logger.info('[dm-reception] 私信回复被配额限制跳过:', quota.reason);
        return false;
      }

      // 发送私信
      const sendRes = await client.sendMessage(
        conv.conversationId,
        conv.conversationShortId,
        reply,
      );

      // API 发送失败时，页面驱动兜底（长期方案）
      if (!sendRes.ok && canUsePageDriver(account.id)) {
        const peerName = otherName || knownConv?.peerName || '';
        const pageSend = await sendDmViaPage(peerName, reply);
        logger.info(
          '[dm-reception][page-driver] 兜底发送',
          pageSend.status,
          pageSend.message || '',
        );
        if (pageSend.ok) {
          sendRes.ok = true;
          sendRes.message = '页面驱动发送成功';
        } else if (pageSend.status === 'session_invalid') {
          logger.error('[dm-reception] 抖音会话失效，需要重新登录账号', account.id);
        }
      }

      // 识别风控响应并上报（冷却期自动跳过该账号）
      if (!sendRes.ok && isRiskResponse(sendRes.message)) {
        riskManager.reportRisk('douyin', account.id, sendRes.message || '私信发送返回风控信号');
      } else if (sendRes.ok) {
        riskManager.reportSuccess('douyin', account.id);
        quotaManager.reportOperation('douyin', account.id, 'dm_reply');
      }

      // 落库记录：发送失败(status=0)的记录存在时更新原记录，避免重复行且保留可重试状态
      if (handledRecord && handledRecord.status === 0) {
        await this.dmReplyRecordRepository.update(handledRecord.id, {
          reply,
          status: sendRes.ok ? 1 : 0,
          updateTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
        });
      } else {
        await this.dmReplyRecordRepository.save({
          userId: getUserInfo().id,
          accountId: account.id,
          type: PlatType.Douyin,
          conversationId: conv.conversationId,
          conversationShortId: conv.conversationShortId,
          serverMessageId: latestIncoming.serverId,
          senderUid: latestIncoming.senderUid,
          senderName: otherName,
          message: latestIncoming.text,
          reply,
          status: sendRes.ok ? 1 : 0,
        });
      }
      if (sendRes.ok) {
        this.mirrorKernelDm({
          accountId: account.id,
          platform: 'douyin',
          sourceId: latestIncoming.serverId,
          peerName: otherName,
          message: latestIncoming.text,
          reply,
        });
      }

      if (sendRes.ok) {
        void appendAutoLog('私信自动回复', `抖音账号 ${account.id} 已完成私信自动回复`);
      }
      logger.info(
        '[dm-reception] 已处理私信',
        account.id,
        conv.conversationShortId,
        sendRes.ok ? '成功' : '失败:' + sendRes.message,
      );
      return sendRes.ok;
    } catch (e) {
      logger.error('[dm-reception] 会话处理出错', account.id, conv.conversationId, e);
      return false;
    }
  }

  private async generateReply(account: AccountModel, message: string): Promise<string | null> {
    try {
      // 内核优先：AI 决策统一走知音 Harness；内核不可用/无有效决策时回退旧后端
      const decided = await decideReception({
        message,
        platform: 'douyin',
        source: 'dm',
      });
      if (decided?.matched && decided.reply) return decided.reply;
      if (decided && !decided.matched) return null;

      const token = getUserToken();
      const res = await fetch(BACKEND_BASE + '/v2/customer-reception/handle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message,
          platform: account.type,
          source: 'dm',
        }),
      });
      const j = await res.json();
      logger.info('[dm-reception][debug] handle响应', res.status, JSON.stringify(j).slice(0, 200));
      const payload = j.data || j;
      if (!payload.matched || !payload.reply) return null;
      return payload.reply;
    } catch (e) {
      logger.error('[dm-reception] 接待规则匹配出错', e);
      return null;
    }
  }

  /**
   * 获取私信回复记录
   */
  async getRecords(limit = 50) {
    return this.dmReplyRecordRepository.find({
      order: { id: 'DESC' },
      take: limit,
    });
  }

  /**
   * 拉取指定账号的会话列表（用于界面预览）
   */
  async listConversations(accountId: number) {
    const account = await this.accountService.getAccountById(accountId);
    if (!account) return [];
    const client = new DouyinImClient(account);
    const convs = await client.getConversations();
    const result = [];
    for (const conv of convs) {
      let senderName = '';
      let lastText = conv.lastText || '';
      try {
        const secUids = conv.users.map((u) => u.secUid).filter((s): s is string => !!s);
        if (secUids.length) {
          const profiles = await client.resolveUsers(secUids);
          const me = profiles.find((u) => u.uniqueId === account.uid);
          const other = profiles.find((u) => u.uid !== me?.uid);
          senderName = other?.nickname || '';
        }
      } catch {}
      result.push({
        conversationId: conv.conversationId,
        conversationShortId: conv.conversationShortId,
        senderName,
        lastText,
      });
    }
    return result;
  }
}
