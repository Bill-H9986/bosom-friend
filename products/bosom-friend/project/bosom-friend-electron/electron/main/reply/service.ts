/*
 * @Author: nevin
 * @Date: 2025-01-24 17:10:35
 * @LastEditors: nevin
 * @Description: Reply reply
 */
import { getBackendBase } from '../config/backendBase'
import { Inject, Injectable } from '../core/decorators';
import PQueue from 'p-queue';
import { AccountModel } from '../../db/models/account';
import platController from '../plat';
import { toolsApi } from '../api/tools';
import { AutoRunModel } from '../../db/models/autoRun';
import { sysNotice } from '../../global/notice';
import { AutorReplyCommentScheduleEvent } from '../../../commont/types/reply';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ReplyCommentRecordModel } from '../../db/models/replyCommentRecord';
import { AppDataSource } from '../../db';
import { getUserInfo, getUserToken } from '../user/comment';
import { WorkData } from '../plat/plat.type';
import { AutoReplyCache, AutorReplyCacheStatus } from './cacheData';
import { logger } from '../../global/log';
import { backPageData, CorrectQuery } from '../../global/table';
import { PlatType } from '../../../commont/AccountEnum';
import { riskManager, randomRange, isRiskResponse } from '../safety/riskManager';
import { quotaManager } from '../safety/quotaManager';
import { checkContent } from '../safety/contentFilter';
import { AccountService } from '../account/service';
import {
  refreshDouyinAccountCookie,
} from '../plat/autoDouyinWindow';
import { refreshXhsAccountCookie } from '../plat/xhsSessionSync';
import { isDouyinSessionValid } from '../safety/sessionGuard';

import {
  replyCommentsViaPage,
  collectPageComments,
  CommentReplyPlan,
} from './commentPageDriver';
import { sleep } from '../../util/time';
import { appendAutoLog } from '../knowledge/autoLog';
import { decideReception } from '../zhiyin/legacy-decision';
import { getKernelRuntime } from '../zhiyin-kernel-host';
import {
  collectXhsComments,
  replyXhsComment,
} from '../plat/platforms/xhs/xhsCommentPageDriver';

const BACKEND_BASE = getBackendBase()

// 抖音页面驱动评论接待的失败退避：连续 4 次失败（页面超时/验证码/风控）后
// 对该账号冷却 30 分钟，避免每轮空跑、反复撞平台风控（对齐小红书 300011 冷却机制）
const pageCommentFailures = new Map<number, { failures: number; cooldownUntil: number }>();
const PAGE_COMMENT_FAIL_MAX = 4;
const PAGE_COMMENT_COOLDOWN_MS = 30 * 60 * 1000;

/** 全局评论接待：账号级监控状态（供「全局监控」页实时展示） */
export interface ReplyAccountStatus {
  accountId: number;
  type: string;
  nickname?: string;
  status: 'scanned' | 'risk' | 'no-login' | 'unsupported' | 'error';
  message?: string;
  at: number;
}

/** 全局评论接待：单轮统计 */
export interface ReplyRoundStats {
  startedAt: number;
  finishedAt: number | null;
  accountsScanned: number;
  accountsSkipped: number;
  worksChecked: number;
  commentsReplied: number;
  errors: number;
}

@Injectable()
export class ReplyService {
  replyQueue: PQueue;
  private replyCommentRecordRepository: Repository<ReplyCommentRecordModel>;
  private commentPollTimer: NodeJS.Timeout | null = null;
  private pollingComments = false;
  private pollRoundToken = 0;
  private lastPollAt: number | null = null;
  private lastRound: ReplyRoundStats | null = null;
  private currentRound: ReplyRoundStats | null = null;
  private accountStatuses: ReplyAccountStatus[] = [];
  /** 小红书页面评论接待：每轮全量处理的节流时间戳 */
  private xhsPageReceptionAt = 0;
  /** 小红书页面评论回复：防止并发轮次争抢同一页面窗口 */
  private xhsReplying = false;

  constructor() {
    this.replyQueue = new PQueue({ concurrency: 1 });
    this.replyCommentRecordRepository = AppDataSource.getRepository(
      ReplyCommentRecordModel,
    );
    // 评论实时自动接待：5~8 分钟随机轮询一次（评论是公开操作，频率必须低于私信）
    this.startCommentPolling();
  }


  @Inject(AccountService)
  private readonly accountService!: AccountService;

  private startCommentPolling() {
    if (this.commentPollTimer) return;
    const scheduleNext = () => {
      // 每 30~50 秒一轮全量读取。调度链与单轮执行完全解耦：
      // 即使某一轮卡死，下一轮照常触发，配合看门狗强制解锁，杜绝整链停摆。
      // 注意：不能用"评论数变化"做增量跳过——创作者接口评论数有缓存，
      // 新评论出现后接口数字不变会导致漏回复。
      this.commentPollTimer = setTimeout(() => {
        void this.runCommentPollRound();
        scheduleNext();
      }, randomRange(30, 50) * 1000);
    };
    // 启动后 5~10 秒先检查一次
    this.commentPollTimer = setTimeout(() => {
      void this.runCommentPollRound();
      scheduleNext();
    }, randomRange(5, 10) * 1000);
  }

  /**
   * 单轮评论轮询：外层看门狗兜底，超时强制复位轮询锁。
   * 轮次令牌：旧轮超时被新轮取代后自行退出，避免两轮并发操作同一窗口。
   */
  private async runCommentPollRound() {
    const round = ++this.pollRoundToken;
    let watchdog: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.pollAllCommentTasks(round),
        new Promise<void>((resolve) => {
          watchdog = setTimeout(() => {
            logger.error('[reply] 评论轮询单轮超时（>5分钟），强制复位轮询锁');
            this.pollingComments = false;
            resolve();
          }, 5 * 60 * 1000);
        }),
      ]);
    } catch (e) {
      logger.error('[reply] 评论轮询出错', e);
    } finally {
      // 轮次正常结束必须清理看门狗定时器，否则 5 分钟后定时器照常触发，
      // 刷出虚假「单轮超时」日志并误复位轮询锁
      if (watchdog) clearTimeout(watchdog);
      // 仅最新一轮复位锁：旧轮的 finally 不得放行新轮
      if (round === this.pollRoundToken) {
        this.pollingComments = false;
      }
    }
  }

  /**
   * 账号级评论轮询：遍历账号下所有已发布作品，实时接待新评论。
   * 盯的是整个账号，而不是某一个视频任务。
   */
  async pollAllCommentTasks(round?: number) {
    if (this.pollingComments) return;
    this.pollingComments = true;
    let roundStats: ReplyRoundStats | null = null;
    try {
      // 已超时被新轮取代：自行退出，避免并发操作同一窗口
      if (round != null && round !== this.pollRoundToken) return;
      const userInfo = getUserInfo();
      if (!userInfo?.id) return;
      // 账号范围对齐私信轮询（不过滤本地用户）：
      // 账号 userId 与本地用户可能不一致（登录同步时序差异），按用户过滤会漏掉真实平台账号
      const accounts = await this.accountService.getAccounts();
      logger.info('[reply] 账号级评论轮询开始，账号数:', accounts.length);
      // 全局监控统计：本轮开始，账户状态清空重建
      this.currentRound = {
        startedAt: Date.now(),
        finishedAt: null,
        accountsScanned: 0,
        accountsSkipped: 0,
        worksChecked: 0,
        commentsReplied: 0,
        errors: 0,
      };
      // 注意：不整体清空 accountStatuses——轮询很快（冷却期秒级完成）时清空会让
      // 全局监控的账号状态表在每轮之间闪成「暂无数据」，误导用户以为未登录。
      // 只剔除已删除账号的旧状态，其余按 accountId upsert 更新。
      const knownIds = new Set(accounts.map(a => a.id));
      this.accountStatuses = this.accountStatuses.filter(s => knownIds.has(s.accountId));
      roundStats = this.currentRound;
      const setAccountStatus = (s: ReplyAccountStatus) => {
        const idx = this.accountStatuses.findIndex(
          (x) => x.accountId === s.accountId,
        );
        if (idx >= 0) this.accountStatuses[idx] = s;
        else this.accountStatuses.push(s);
      };
      let accountIndex = 0;
      for (const account of accounts) {
        if (round != null && round !== this.pollRoundToken) return;
        // 多账号错峰：除第一个账号外，账号之间随机延迟 15~45 秒，
        // 避免多个账号在同一时刻操作平台，降低并发风控风险
        if (accountIndex++ > 0) {
          logger.info(
            '[reply] 账号间错峰等待',
            Math.round(randomRange(15, 45)),
            '秒后处理下一个账号',
          );
          await sleep(randomRange(15, 45) * 1000);
        }
        // 当前支持：抖音（页面驱动）、小红书/快手/视频号（API 直连）
        if (
          account.type !== PlatType.Douyin &&
          account.type !== PlatType.Xhs &&
          account.type !== PlatType.KWAI &&
          account.type !== PlatType.WxSph
        ) {
          logger.info('[reply] 平台', account.type, '暂未开放账号级评论自动回复，跳过');
          roundStats.accountsSkipped++;
          setAccountStatus({
            accountId: account.id,
            type: account.type,
            nickname: account.nickname,
            status: 'unsupported',
            message: '平台暂未开放评论自动回复',
            at: Date.now(),
          });
          continue;
        }
        // 风控冷却中的账号跳过
        const risk = riskManager.canOperate(account.type, account.id);
        if (!risk.ok) {
          logger.info('[reply] 账号', account.id, '风控冷却中，跳过账号级评论轮询');
          roundStats.accountsSkipped++;
          setAccountStatus({
            accountId: account.id,
            type: account.type,
            nickname: account.nickname,
            status: 'risk',
            message: risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
              ? '风控冷却中，还需约 ' + Math.ceil(risk.waitMs / 60000) + ' 分钟'
              : '风控冷却中（严重风控，需人工处理）',
            at: Date.now(),
          });
          continue;
        }

          // 登录态：纯后台静默处理。会话失效仅记录状态并跳过本轮，
          // 绝不弹任何窗口（登录弹窗只允许用户在账号管理手动触发）。
          if (account.type === PlatType.Douyin) {
            const valid = await isDouyinSessionValid(account.id, account.loginCookie)
            if (!valid) {
              logger.info('[reply] 抖音会话失效，本轮静默跳过（等待用户手动登录）', account.id)
              roundStats.accountsSkipped++;
              setAccountStatus({
                accountId: account.id,
                type: account.type,
                nickname: account.nickname,
                status: 'no-login',
                message: '抖音未登录（请到账号管理手动登录）',
                at: Date.now(),
              });
              continue
            }
          }

        // 账号级：分页拉取该账号全部已发布作品，逐个检查评论并回复
        let pcursor: string | undefined = undefined;
        let hasMore = true;
        let checkedWorks = 0;
        const MAX_WORKS_PER_ROUND = 30; // 每轮每账号最多检查 30 个作品（作品列表按发布时间倒序，优先最新）
        logger.info('[reply] 账号', account.id, '开始账号级作品遍历');
        while (hasMore && checkedWorks < MAX_WORKS_PER_ROUND) {
          let workPage: { list: WorkData[]; pageInfo: { hasMore?: boolean; pcursor?: string } };
          try {
            // 每次拉取前用自动窗口实时会话刷新账号 cookie，避免历史 cookie 过期导致接口判定未登录
            if (account.type === PlatType.Douyin) {
              await refreshDouyinAccountCookie(account);
            }
            if (account.type === PlatType.Xhs) {
              await refreshXhsAccountCookie(account);
            }
            workPage = await platController.getWorkList(account, pcursor);
          } catch (e) {
            logger.error('[reply] 获取账号', account.id, '作品列表失败', e);
            roundStats.errors++;
            setAccountStatus({
              accountId: account.id,
              type: account.type,
              nickname: account.nickname,
              status: 'error',
              message: '获取作品列表失败（可能未登录或接口异常）',
              at: Date.now(),
            });
            break;
          }
          const list = workPage?.list || [];
          logger.info(
            '[reply] 账号',
            account.id,
            '拉取作品列表页成功，本页作品数:',
            list.length,
            'hasMore:',
            workPage?.pageInfo?.hasMore,
            '已累计检查:',
            checkedWorks,
          );
          if (list.length === 0) break;

          for (const work of list) {
            if (checkedWorks >= MAX_WORKS_PER_ROUND) break;
            checkedWorks++;
            roundStats.worksChecked++;
            try {
              let workTimer: NodeJS.Timeout | null = null;
              const workTask =
                account.type === PlatType.Douyin
                  ? this.autorReplyPageComments(account, work) // 抖音：页面驱动
                  : this.autorReplyApiComments(account, work); // 小红书/快手/视频号：API 直连
              await Promise.race([
                workTask.then(() => {
                  if (workTimer) clearTimeout(workTimer);
                }),
                new Promise<false>((resolve) => {
                  workTimer = setTimeout(() => {
                    logger.error(
                      '[reply] 作品',
                      work.dataId,
                      '评论接待超时，跳过本轮',
                    );
                    resolve(false);
                  }, 90000);
                }),
              ]);
            } catch (e) {
              logger.error('[reply] 作品', work.dataId, '评论轮询出错', e);
              roundStats.errors++;
            }
            // 作品之间随机间隔，模拟真人节奏，降低风控风险
            await sleep(randomRange(1500, 4000));
          }

          hasMore = !!workPage?.pageInfo?.hasMore;
          pcursor = workPage?.pageInfo?.pcursor;
          if (!pcursor) break;
        }
        logger.info('[reply] 账号', account.id, '账号级作品遍历完成，共检查作品:', checkedWorks);
        roundStats.accountsScanned++;
        setAccountStatus({
          accountId: account.id,
          type: account.type,
          nickname: account.nickname,
          status: 'scanned',
          message: '本轮已检查 ' + checkedWorks + ' 个作品',
          at: Date.now(),
        });
      }
      logger.info('[reply] 账号级评论轮询完成');
      this.lastPollAt = Date.now();
      this.lastRound = { ...roundStats, finishedAt: Date.now() };
    } catch (e) {
      logger.error('[reply] 账号级评论轮询失败', e);
      if (roundStats) {
        roundStats.errors++;
        this.lastPollAt = Date.now();
        this.lastRound = { ...roundStats, finishedAt: Date.now() };
      }
    } finally {
      // 仅清除本轮自己的统计对象：轮次超时被新轮取代时，不得误清新轮的 currentRound
      if (this.currentRound === roundStats) this.currentRound = null;
      this.pollingComments = false;
    }
  }

  /** 全局评论接待监控状态（「全局监控」页实时展示） */
  getMonitorStatus() {
    return {
      enabled: true,
      pollingNow: this.pollingComments,
      lastPollAt: this.lastPollAt,
      lastRound: this.lastRound,
      accountStatuses: this.accountStatuses,
    };
  }

  /**
   * 账号级评论自动接待（页面数据源）：
   * 1. 从作品评论管理页读取未回复评论（与页面完全一致，杜绝 API/页面数据不一致）
   * 2. 逐条 AI 决策并生成回复（Agnes 默认）
   * 3. 同一页面会话内批量回复
   * 4. 落库去重
   */
  async autorReplyPageComments(account: AccountModel, work: WorkData) {
    const userInfo = getUserInfo();
    logger.info('[reply-debug] autorReplyPageComments 进入，作品', work.dataId, 'userInfo:', userInfo?.id || 'NULL');
    if (!userInfo?.id) return false;

    const risk = riskManager.canOperate(account.type, account.id);
    if (!risk.ok) {
      logger.info('[reply] 账号', account.id, '风控冷却中，跳过评论接待');
      return false;
    }
    // 页面驱动失败退避冷却：连续失败后本轮直接跳过该账号
    const pcRisk = pageCommentFailures.get(account.id);
    if (pcRisk && pcRisk.cooldownUntil > Date.now()) {
      logger.info('[reply] 账号', account.id, '页面评论读取失败频发，冷却中（', Math.ceil((pcRisk.cooldownUntil - Date.now()) / 60000), '分钟）');
      return false;
    }

    // 1. 页面读取未回复评论
    const { ok, comments, message } = await collectPageComments(
      work.dataId,
      work.title || work.desc || '',
      work.createTime,
    );
    if (!ok) {
      logger.info('[reply] 页面读取评论失败:', message, '作品', work.dataId);
      // 连续失败计数：达到阈值后冷却 30 分钟，并同步上报持久化风控（重启不丢）
      const cur = pageCommentFailures.get(account.id) ?? { failures: 0, cooldownUntil: 0 };
      cur.failures += 1;
      if (cur.failures >= PAGE_COMMENT_FAIL_MAX) {
        cur.cooldownUntil = Date.now() + PAGE_COMMENT_COOLDOWN_MS;
        cur.failures = 0;
        // 页面加载超时是驱动环境问题，不是平台风控信号：只做评论接待自身的
        // 短时退避，不污染持久化风控状态，避免误伤同一账号的发布/私信链路。
        if (isRiskResponse(message)) {
          riskManager.reportRisk(
            account.type,
            account.id,
            '页面评论读取连续失败' + PAGE_COMMENT_FAIL_MAX + '次: ' + String(message).slice(0, 60),
          );
        }
      }
      pageCommentFailures.set(account.id, cur);
      return false;
    }
    // 读取成功：清零连续失败计数
    pageCommentFailures.set(account.id, { failures: 0, cooldownUntil: 0 });
    logger.info('[reply-debug] collectPageComments 返回条数:', comments.length, '作品', work.dataId);
    if (comments.length === 0) return true;

    // 二次核对：用抖音 web 评论接口的权威回复状态过滤已回复评论。
    // 原因：创作者后台页面回复标记存在延迟（回复已发出但页面暂不显示"查看N条回复"），
    // 仅靠页面标记+DB 会重复回复或漏回复。
    let repliedCidSet: Set<string> | null = null;
    try {
      const webRes = await platController.getCommentList(account, work);
      repliedCidSet = new Set<string>();
      for (const c of webRes?.list || []) {
        // 只有子回复中存在「本账号自己发出的回复」才视为已回复；
        // 其它用户的回复不算，避免把未接待的评论误判为已回复而漏掉。
        const hasOwnReply = (c.subCommentList || []).some((sub: any) => {
          const subUid = sub?.user?.uid ?? sub?.user_id ?? sub?.userId;
          return subUid != null && String(subUid) === String(account.uid);
        });
        if (c.commentId && hasOwnReply) {
          repliedCidSet.add(String(c.commentId));
        }
      }
    } catch (e) {
      logger.info('[reply] web 接口回复状态核对失败，回退页面标记:', e);
    }
    logger.info('[reply-debug] web 核对完成，repliedCidSet:', repliedCidSet?.size ?? 'N/A', '作品', work.dataId);

    // 2. AI 决策 + 生成回复（先收集，最后统一页面驱动发送）
    const pendingReplies: CommentReplyPlan[] = [];
    for (const c of comments) {
      if (repliedCidSet && c.cid && repliedCidSet.has(c.cid)) {
        logger.info('[reply] web 接口确认已回复，跳过:', c.cid);
        continue;
      }
      // 数据库去重：按评论唯一 ID（cid）精准匹配。
      // 注意：不能用评论文本匹配，否则相同文本的新评论会被误判为已回复而漏接待。
      const oldRecord = await this.getReplyCommentRecord(
        userInfo.id,
        account,
        c.key,
      );
      if (oldRecord) {
        logger.info('[reply] 评论已回复过（按评论ID），跳过:', c.cid || c.key);
        continue;
      }
      // 兼容历史记录（旧记录无 cid）：按评论文本兜底匹配，
      // 但仅当发布时间差在 5 分钟内才视为同一评论，防止相同文本的新评论被误跳过
      if (c.createTime && c.commentText) {
        const byText = await this.replyCommentRecordRepository.findOne({
          where: {
            userId: userInfo.id,
            accountId: account.id,
            type: account.type,
            commentContent: c.commentText,
          },
        });
        if (byText) {
          const dbTime = new Date(
            String(byText.createTime).replace(' ', 'T') + 'Z',
          ).getTime();
          const commentTime = c.createTime * 1000;
          if (Math.abs(dbTime - commentTime) < 5 * 60 * 1000) {
            logger.info(
              '[reply] 评论已回复过（按内容+时间匹配），跳过:',
              c.commentText.slice(0, 40),
            );
            continue;
          }
        }
      }

      const aiRes =
        (await decideReception({
          message: c.commentText,
          platform: account.type,
          source: 'comment',
        })) ??
        (await toolsApi.aiReceptionHandle({
          message: c.commentText,
          platform: account.type,
          source: 'comment',
        }));
      if (!aiRes || !aiRes.matched || !aiRes.reply) {
        logger.info(
          '[reply] 评论被AI判定无需回复，跳过:',
          c.commentText.slice(0, 40),
        );
        continue;
      }

      const contentCheck = checkContent(aiRes.reply);
      if (!contentCheck.ok) {
        logger.info(
          '[reply] 评论回复命中敏感词已拦截:',
          contentCheck.hitWords.join('、'),
        );
        continue;
      }

      const quota = quotaManager.canOperate(
        account.type,
        account.id,
        'comment_reply',
      );
      if (!quota.ok) {
        logger.info('[reply] 评论回复被配额限制跳过:', quota.reason);
        continue;
      }

      pendingReplies.push({
        commentId: c.key,
        username: c.username,
        commentText: c.commentText,
        reply: aiRes.reply,
      });
    }

    if (pendingReplies.length === 0) return true;

    // 3. 页面驱动批量回复
    const batchRes = await replyCommentsViaPage(
      work.dataId,
      work.title || work.desc || '',
      pendingReplies,
    );
    logger.info(
      '[reply] 页面驱动批量回复结果',
      JSON.stringify({
        ok: batchRes.ok,
        message: batchRes.message || '',
        resultCount: batchRes.results.length,
        statuses: batchRes.results.map((r) => r.status),
      }),
    );

    // 全局监控统计：本轮成功回复条数
    if (this.currentRound) {
      this.currentRound.commentsReplied += batchRes.results.filter(
        (r) => r.ok,
      ).length;
    }

    // 4. 落库防重复
    for (const res of batchRes.results) {
      const plan = pendingReplies.find((p) => p.commentId === res.commentId);
      if (!plan) continue;
      if (!res.ok) {
        if (isRiskResponse(res.message)) {
          riskManager.reportRisk(
            account.type,
            account.id,
            res.message || '评论回复返回风控信号',
          );
        }
        continue;
      }
      quotaManager.reportOperation(account.type, account.id, 'comment_reply');
      await this.createReplyCommentRecord(userInfo.id, account, {
        id: plan.commentId,
        commentContent: plan.commentText,
        replyContent: plan.reply,
        workId: work.dataId,
        nickname: plan.username,
      });
    }
    return true;
  }

  /**
   * 小红书评论自动接待（API 直连版）：
   * 1. 分页拉取作品评论（getCommentList）
   * 2. 过滤：作者自己的评论、已回复（子评论含 is_author）、DB 已记录
   * 3. AI 决策生成回复
   * 4. commentPost API 直连发送（带 X-S/X-T 签名）
   */
  async autorReplyApiComments(account: AccountModel, work: WorkData) {
    // 小红书 API 直连被个人账号风控（300011 Account abnormal），
    // 评论接待改为浏览器页面驱动，绕开评论 API。
    if (account.type === PlatType.Xhs) {
      return this.autorReplyXhsPageComments(account, work);
    }
    const userInfo = getUserInfo();
    if (!userInfo?.id) return false;

    const platformName = account.type === PlatType.KWAI ? '快手' : '视频号';

    const risk = riskManager.canOperate(account.type, account.id);
    if (!risk.ok) {
      logger.info('[reply]', platformName, '账号', account.id, '风控冷却中，跳过评论接待');
      return false;
    }

    // 1. 分页拉取评论，收集待回复
    const pendingReplies: {
      commentId: string;
      commentText: string;
      reply: string;
      comment: any;
    }[] = [];
    let pcursor: string | undefined;
    let hasMore = true;
    let pages = 0;
    const MAX_PAGES = 5;
    while (hasMore && pages < MAX_PAGES) {
      pages++;
      let pageRes: any;
      try {
        pageRes = await platController.getCommentList(account, work, pcursor);
      } catch (e) {
        logger.error('[reply]', platformName, '拉取评论失败:', e);
        break;
      }
      const list = pageRes?.list || [];
      if (list.length === 0) break;

      for (const c of list) {
        const raw = c.data || {};
        // 快手/视频号：存在子评论即视为已回复（安全优先，宁可漏回不可重复回）
        if ((c.subCommentList?.length ?? 0) > 0) continue;

        const key = `cid:${c.commentId}`;
        const old = await this.getReplyCommentRecord(userInfo.id, account, key);
        if (old) continue;

        const aiRes =
          (await decideReception({
            message: c.content,
            platform: account.type,
            source: 'comment',
          })) ??
          (await toolsApi.aiReceptionHandle({
            message: c.content,
            platform: account.type,
            source: 'comment',
          }));
        if (!aiRes || !aiRes.matched || !aiRes.reply) {
          logger.info(
            '[reply]', platformName, '评论被AI判定无需回复，跳过:',
            c.content.slice(0, 30),
          );
          continue;
        }
        const contentCheck = checkContent(aiRes.reply);
        if (!contentCheck.ok) {
          logger.info(
            '[reply]', platformName, '回复命中敏感词已拦截:',
            contentCheck.hitWords.join('、'),
          );
          continue;
        }
        const quota = quotaManager.canOperate(
          account.type,
          account.id,
          'comment_reply',
        );
        if (!quota.ok) {
          logger.info('[reply]', platformName, '评论回复被配额限制:', quota.reason);
          continue;
        }
        pendingReplies.push({
          commentId: c.commentId,
          commentText: c.content,
          reply: aiRes.reply,
          comment: raw,
        });
      }

      pcursor = pageRes?.pageInfo?.pcursor;
      hasMore = !!pageRes?.pageInfo?.hasMore;
      if (!pcursor) break;
    }

    if (pendingReplies.length === 0) return true;

    // 2. API 直连逐条回复（每条间隔随机，模拟真人节奏）
    logger.info('[reply]', platformName, '待回复评论数:', pendingReplies.length);
    for (const p of pendingReplies) {
      try {
        const res: any = await platController.replyComment(
          account,
          work,
          p.commentId,
          p.reply,
          p.comment,
        );
        const ok =
          account.type === PlatType.KWAI
            ? res?.status === 200 && res?.data?.result === 1
            : res?.status === 200 || res?.status === 201;
        if (ok) {
          quotaManager.reportOperation(account.type, account.id, 'comment_reply');
          if (this.currentRound) this.currentRound.commentsReplied += 1;
          await this.createReplyCommentRecord(userInfo.id, account, {
            id: `cid:${p.commentId}`,
            commentContent: p.commentText,
            replyContent: p.reply,
            workId: work.dataId,
          });
          logger.info(
            '[reply]', platformName, '评论回复成功:',
            p.commentText.slice(0, 30),
          );
          void appendAutoLog('评论自动回复', `${platformName} 已自动回复评论: ${p.commentText.slice(0, 30)}`);
        } else {
          // 风控/失败信息优先取顶层字段（xhs 300011 的 code/msg 在顶层，
          // 不在 data 内），并把错误码一并交给风控识别
          const msg =
            res?.msg ||
            res?.data?.msg ||
            res?.data?.toast ||
            (res?.code != null ? `平台错误码 ${res.code}` : '') ||
            JSON.stringify(res?.data || {});
          logger.info('[reply]', platformName, '评论回复失败:', msg);
          const httpStatus = typeof res?.status === 'number' ? res.status : undefined;
          if (res?.code === 300011 || isRiskResponse(msg, httpStatus)) {
            riskManager.reportRisk(
              account.type,
              account.id,
              `${platformName}评论回复风控信号: ${String(msg).slice(0, 80)}`,
            );
          }
        }
      } catch (e) {
        logger.error('[reply]', platformName, '评论回复异常:', e);
      }
      // 每条回复之间随机间隔 8~15 秒
      await sleep(randomRange(8000, 15000));
    }
    return true;
  }

  /**
   * 小红书评论自动接待（页面驱动版）：
   * 评论管理页网络拦截读取评论 → AI 决策 → DOM 回复（个人账号绕开 300011 风控）
   */
  private async autorReplyXhsPageComments(
    account: AccountModel,
    work: WorkData,
  ): Promise<boolean> {
    const userInfo = getUserInfo();
    if (!userInfo?.id)
      return false;
    const risk = riskManager.canOperate(account.type, account.id);
    if (!risk.ok) {
      logger.info('[reply] 小红书账号', account.id, '风控冷却中，跳过评论接待');
      return false;
    }
    if (this.xhsReplying)
      return true;
    this.xhsReplying = true;

    try {
      // 账号级全量接待：每轮只读一次并处理全部评论，后续作品调用复用本轮结果
      if (Date.now() - this.xhsPageReceptionAt < 30_000)
        return true;
      const items = await collectXhsComments();
      this.xhsPageReceptionAt = Date.now();
      if (items.length === 0) {
        logger.info('[reply-debug] 小红书页面读取评论 0 条（未登录或暂无新评论）');
        return true;
      }

      let idx = 0;
      for (const item of items) {
        // 每条之间随机间隔（含跳过项），模拟真人节奏 + 防风控
        if (idx++ > 0)
          await sleep(randomRange(8000, 15000));
        const key = `cid:${item.commentId}`;
        const old = await this.getReplyCommentRecord(userInfo.id, account, key);
        if (old)
          continue;
        const aiRes =
          (await decideReception({
            message: item.content,
            platform: account.type,
            source: 'comment',
          })) ??
          (await toolsApi.aiReceptionHandle({
            message: item.content,
            platform: account.type,
            source: 'comment',
          }));
        if (!aiRes || !aiRes.matched || !aiRes.reply) {
          logger.info('[reply] 小红书评论被AI判定无需回复，跳过:', item.content.slice(0, 30));
          continue;
        }
        const contentCheck = checkContent(aiRes.reply);
        if (!contentCheck.ok)
          continue;
        const quota = quotaManager.canOperate(account.type, account.id, 'comment_reply');
        if (!quota.ok) {
          logger.info('[reply] 小红书评论回复被配额限制:', quota.reason);
          continue;
        }

        const sent = await replyXhsComment(item.noteId, item.content, aiRes.reply);
        if (sent.ok) {
          quotaManager.reportOperation(account.type, account.id, 'comment_reply');
          if (this.currentRound)
            this.currentRound.commentsReplied += 1;
          await this.createReplyCommentRecord(userInfo.id, account, {
            id: key,
            commentContent: item.content,
            replyContent: aiRes.reply,
            workId: work.dataId,
          });
          logger.info('[reply] 小红书页面驱动评论回复成功:', item.content.slice(0, 30));
          void appendAutoLog('评论自动回复', `小红书已自动回复评论: ${item.content.slice(0, 30)}`);
        }
        else {
          logger.info('[reply] 小红书页面驱动评论回复失败:', sent.message || '');
        }
      }
      return true;
    }
    finally {
      this.xhsReplying = false;
    }
  }

  /**
   * 创建评论回复记录
   * @param userId
   * @param account
   * @param comment
   * @returns
   */
  async createReplyCommentRecord(
    userId: string,
    account: AccountModel,
    comment: {
      id: string;
      commentContent: string;
      replyContent: string;
      workId?: string;
      nickname?: string;
      },
    ) {
      const record = await this.replyCommentRecordRepository.save({
        userId,
        accountId: account.id,
        type: account.type,
        commentId: comment.id + '',
        commentContent: comment.commentContent,
        replyContent: comment.replyContent,
        workId: comment.workId,
      });
      // 同步上报到数据统计（评论搜索），失败不影响主流程
      this.reportCommentToBackend({
        workId: comment.workId ?? '',
        commentId: comment.id + '',
        content: comment.commentContent,
        reply: comment.replyContent,
        nickname: comment.nickname,
        createdAt: record.createTime?.toISOString(),
        platform: account.type,
      }).catch(() => {});
      // 统一数据层：成功接待同时写回内核，页面/统计/AI 共用一份数据
      getKernelRuntime()?.recordInteraction({
        id: `c${record.id}`,
        kind: 'comment',
        platform: String(account.type),
        accountId: account.id,
        sourceId: comment.id,
        workId: comment.workId,
        content: comment.commentContent,
        reply: comment.replyContent,
        repliedAt: new Date().toISOString(),
        status: 'replied',
      });
      return record;
    }

  /**
   * 向数据统计上报一条评论记录（失败不影响主流程）
   */
  private async reportCommentToBackend(comment: {
    workId: string;
    commentId: string;
    content: string;
    reply?: string;
    nickname?: string;
    createdAt?: string;
    platform?: string;
  }): Promise<void> {
    try {
      const token = getUserToken();
      if (!token) return;
      // 幂等 key：workId + commentId 复合，同一评论重复轮询重放不重复计数
      const idempotencyKey = `${comment.workId}:${comment.commentId}`;
      await fetch(`${BACKEND_BASE}/v2/statistics/desktop/comment-records`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          comments: [{
            workId: comment.workId,
            commentId: comment.commentId,
            content: comment.content,
            reply: comment.reply,
            nickname: comment.nickname || '访客',
            createdAt: comment.createdAt,
            platform: comment.platform,
            idempotencyKey,
          }],
        }),
        signal: AbortSignal.timeout(15000),
      });
    }
    catch {
      // 上报失败不影响评论回复主流程
    }
  }

  // 获取平台的评论记录
  async getReplyCommentRecord(
    userId: string,
    account: AccountModel,
    commentId: string,
  ) {
    return await this.replyCommentRecordRepository.findOne({
      where: {
        userId,
        accountId: account.id,
        type: account.type,
        commentId: commentId + '',
      },
    });
  }

  // 获取评论回复记录列表
  async getReplyCommentRecordList(
    userId: string,
    page: CorrectQuery,
    query: {
      accountId?: number;
      type?: PlatType;
    },
  ) {
    const filter: FindOptionsWhere<ReplyCommentRecordModel> = {
      userId,
      ...(query.accountId && { accountId: query.accountId }),
      ...(query.type && { type: query.type }),
    };

    const [list, totalCount] =
      await this.replyCommentRecordRepository.findAndCount({
        where: filter,
      });

    return backPageData(list, totalCount, page);
  }

  /**
   * 自动一键评论
   * 规则:评论所有的一级评论,已经在评论记录的不评论
   */
  async autorReplyComment(
    account: AccountModel,
    data: WorkData,
    scheduleEvent: (data: {
      tag: AutorReplyCommentScheduleEvent;
      status: -1 | 0 | 1; // -1 错误 0 进行中 1 完成
      data?: any; // 数据
      error?: any;
    }) => void,
    options?: { maxReplyCount?: number; maxCommentPages?: number },
  ) {
    const userInfo = getUserInfo();
    let theHasMore = true;
    let thePcursor = undefined;
    let collectedReplyCount = 0;
    let commentPages = 0;
    // 收集本作品本次轮询需要回复的评论，批量在一个页面会话中逐条回复（减少页面跳转，降低风控风险）
    const pendingReplies: {
      commentId: string;
      username?: string;
      commentText: string;
      reply: string;
    }[] = [];

    // 风控冷却中的账号不启动评论任务
    const risk = riskManager.canOperate(account.type, account.id);
    if (!risk.ok) {
      logger.info(
        '[reply] 账号',
        account.id,
        '处于风控冷却期，跳过评论回复任务',
        risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
          ? `还需 ${Math.ceil((risk.waitMs || 0) / 60000)} 分钟`
          : '（严重风控，需人工处理）',
      );
      scheduleEvent({
        tag: AutorReplyCommentScheduleEvent.Error,
        status: -1,
        error: '账号处于风控冷却期，已自动跳过',
      });
      return false;
    }

    // 设置缓存数据
    const cacheData = new AutoReplyCache({
      title: data.title || data.desc || '无',
      dataId: data.dataId,
    });

    try {
      scheduleEvent({
        tag: AutorReplyCommentScheduleEvent.Start,
        status: 0,
      });

      while (theHasMore) {
        // 达到本作品评论拉取页数上限后停止，防止评论特别多的作品拖垮整轮轮询
        if (options?.maxCommentPages && commentPages >= options.maxCommentPages) {
          break;
        }
        commentPages++;
        cacheData.extendTTL(); // 延长缓存时间

        scheduleEvent({
          tag: AutorReplyCommentScheduleEvent.GetCommentListStart,
          status: 0,
        });

        // 1. 获取评论列表
        const {
          list,
          pageInfo: { pcursor, hasMore },
        } = await platController.getCommentList(account, data, thePcursor);

        if (list.length === 0) {
          break;
        }

        scheduleEvent({
          tag: AutorReplyCommentScheduleEvent.GetCommentListEnd,
          status: 0,
        });

        // 2. 循环AI决策回复内容（先收集，最后统一页面驱动发送）
        for (const element of list) {
          // 达到本作品回复上限后停止继续拉取评论
          if (
            options?.maxReplyCount &&
            collectedReplyCount >= options.maxReplyCount
          ) {
            theHasMore = false;
            break;
          }
          // 判断是否已经回复
          const oldRecord = await this.getReplyCommentRecord(
            userInfo.id,
            account,
            element.commentId,
          );
          if (oldRecord) continue;

          // 判断是否已经回复
          let hadReply = false;
          for (const reply of element.subCommentList) {
            if (account.uid === reply.userId) {
              hadReply = true;
              break;
            }
          }
          if (!!hadReply) continue;

          // 由大模型决策是否回复 + 生成回复内容（Agnes 默认，规则仅作业务上下文）
          const aiRes =
            (await decideReception({
              message: element.content,
              platform: account.type,
              source: 'comment',
            })) ??
            (await toolsApi.aiReceptionHandle({
              message: element.content,
              platform: account.type,
              source: 'comment',
            }));
          // 大模型判断无需回复（垃圾/广告等）则跳过该评论
          if (!aiRes || !aiRes.matched) {
            continue;
          }
          if (!aiRes.reply) {
            scheduleEvent({
              tag: AutorReplyCommentScheduleEvent.Error,
              status: -1,
              error: '未获得AI产出内容',
            });
            cacheData.updateStatus(
              AutorReplyCacheStatus.REEOR,
              '未获得AI产出内容',
            );
            return false;
          }
          const aiReplyContent = aiRes.reply;

          // 内容安全：AI 回复发送前过敏感词过滤，命中则跳过该评论（合法合规底线）
          const contentCheck = checkContent(aiReplyContent);
          if (!contentCheck.ok) {
            logger.info(
              '[reply] 评论回复命中敏感词已拦截:',
              contentCheck.hitWords.join('、'),
            );
            continue;
          }

          // 操作配额检查
          const quota = quotaManager.canOperate(account.type, account.id, 'comment_reply');
          if (!quota.ok) {
            logger.info('[reply] 评论回复被配额限制跳过:', quota.reason);
            continue;
          }

          scheduleEvent({
            tag: AutorReplyCommentScheduleEvent.ReplyCommentStart,
            data: {
              content: element.content,
              aiContent: aiReplyContent,
            },
            status: 0,
          });

          pendingReplies.push({
            commentId: element.commentId + '',
            username: element.nikeName,
            commentText: element.content,
            reply: aiReplyContent,
          });
          collectedReplyCount++;
        }

        thePcursor = pcursor;
        theHasMore = !!hasMore;
      }

      // 3. 批量页面驱动回复（抖音评论接口已升级签名，API 直连失效；页面驱动由页面自生成签名）
      if (pendingReplies.length > 0) {
        const batchRes = await replyCommentsViaPage(
          String(data.dataId || ''),
          data.title || data.desc || '',
          pendingReplies,
        );
        logger.info(
          '[reply] 页面驱动批量回复结果',
          JSON.stringify({
            ok: batchRes.ok,
            message: batchRes.message || '',
            resultCount: batchRes.results.length,
            statuses: batchRes.results.map((r) => r.status),
          }),
        );
        for (const res of batchRes.results) {
          const plan = pendingReplies.find((p) => p.commentId === res.commentId);
          if (!plan) continue;
          if (!res.ok) {
            // 仅真正的风控信号才上报（环境问题如找不到评论不应误报风控）
            if (isRiskResponse(res.message)) {
              riskManager.reportRisk(
                account.type,
                account.id,
                res.message || '评论回复返回风控信号',
              );
            }
            continue;
          }
          quotaManager.reportOperation(account.type, account.id, 'comment_reply');
          // 创建评论记录（防止重复回复）
          this.createReplyCommentRecord(userInfo.id, account, {
            id: plan.commentId,
            commentContent: plan.commentText,
            replyContent: plan.reply,
            workId: String(data.dataId || ''),
            nickname: plan.username,
          });
        }
      }

      scheduleEvent({
        tag: AutorReplyCommentScheduleEvent.ReplyCommentEnd,
        status: 0,
      });
      scheduleEvent({
        tag: AutorReplyCommentScheduleEvent.End,
        status: 0,
      });
      // 清除缓存
      cacheData.delete();
      return true;
    } catch (error) {
      scheduleEvent({
        tag: AutorReplyCommentScheduleEvent.Error,
        status: -1,
        error,
      });
      logger.error(['自动一键评论发生错误', error]);
      cacheData.updateStatus(AutorReplyCacheStatus.REEOR, '进行中发生错误');
      return false;
    }

    // 清除缓存
    cacheData.delete();
  }

  /**
   * 添加作品回复评论的任务到队列
   * @param account
   * @param data
   * @param autoRun
   */
  async addReplyQueue(
    account: AccountModel,
    data: WorkData,
    autoRun: AutoRunModel,
  ): Promise<{
    status: 0 | 1;
    message?: string;
  }> {
    // 创建任务执行记录
    const recordData = { id: autoRun.id };

    // 添加到队列
    this.replyQueue.add(() => {
      this.autorReplyComment(
        account,
        data,
        (e: {
          tag: AutorReplyCommentScheduleEvent;
          status: -1 | 0 | 1;
          error?: any;
        }) => {
          if (e.tag === AutorReplyCommentScheduleEvent.Start) {
            sysNotice('自动评论回复任务执行开始', `任务ID:${autoRun.id}`);
          }

          if (e.tag === AutorReplyCommentScheduleEvent.End) {
            sysNotice('自动评论回复任务执行结束', `任务ID:${autoRun.id}`);
          }

          if (e.tag === AutorReplyCommentScheduleEvent.Error) {
            sysNotice('自动评论回复任务-错误!!!', `任务ID:${autoRun.id}`);
          }
        },
      );
    });

    return {
      status: 1,
    };
  }
}
