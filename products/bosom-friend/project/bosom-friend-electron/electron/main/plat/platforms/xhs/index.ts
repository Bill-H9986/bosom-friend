/*
 * @Author: nevin
 * @Date: 2025-02-08 11:40:45
 * @LastEditTime: 2025-03-24 23:35:16
 * @LastEditors: nevin
 * @Description: 小红书
 */
import { PlatformBase } from '../../PlatformBase';
import {
  AccountInfoTypeRV,
  CommentData,
  CookiesType,
  DashboardData,
  IAccountInfoParams,
  IGetLocationDataParams,
  IGetTopicsParams,
  IGetTopicsResponse,
  IGetUsersParams,
  VideoCallbackType,
  WorkData,
} from '../../plat.type';
import { PublishVideoResult } from '../../module';
import {
  xiaohongshuService,
  XSLPlatformSettingType,
} from '../../../../plat/xiaohongshu';
import { PlatType } from '../../../../../commont/AccountEnum';
import { AccountModel } from '../../../../db/models/account';
import { VisibleTypeEnum } from '../../../../../commont/publish/PublishEnum';
import { CookieToString } from '../../../../plat/utils';
import { riskManager } from '../../../safety/riskManager';
import { AppDataSource } from '../../../../db';
import { logger } from '../../../../global/log';
import { VideoModel } from '../../../../db/models/video';
import { WorkDataModel } from '../../../../db/models/workData';
import { ImgTextModel } from '../../../../db/models/imgText';

// 评论风控节流：xhs 评论接口在请求过于密集时返回 300011（Account abnormal），
// 连续 5 次后对该账号冷却 30 分钟，期间直接跳过调用，让平台风控状态自然恢复。
const commentRisk = new Map<number, { failures: number; cooldownUntil: number }>();
let lastCommentCallAt = 0;
const COMMENT_GAP_MS = 2500;
const COMMENT_COOLDOWN_MS = 30 * 60 * 1000;

/** 记录一次评论接口风控命中（读/写共用），连续 5 次进入冷却 */
function recordCommentRisk(accountId: number, hitRisk: boolean): void {
  const cur = commentRisk.get(accountId) ?? { failures: 0, cooldownUntil: 0 };
  if (hitRisk) {
    cur.failures += 1;
    if (cur.failures >= 5) {
      cur.cooldownUntil = Date.now() + COMMENT_COOLDOWN_MS;
      cur.failures = 0;
      console.log('[xhs] 评论接口 300011 频发，账号', accountId, '评论轮询冷却 30 分钟');
    }
  } else {
    cur.failures = 0;
  }
  commentRisk.set(accountId, cur);
}

/** 账号评论接口是否处于风控冷却期 */
function isCommentCooling(accountId: number): boolean {
  const risk = commentRisk.get(accountId);
  return !!risk && risk.cooldownUntil > Date.now();
}

export class Xhs extends PlatformBase {
  constructor() {
    super(PlatType.Xhs);
  }

  /** 取消登录：关闭登录窗口并结束等待 */
  override cancelLogin() {
    xiaohongshuService.cancelLogin();
  }

  /**
   * 登录
   * @returns
   */
  async login() {
    try {
      const { success, data, error } =
        await xiaohongshuService.loginOrView('login');
      if (!success || !data) {
        console.log('Login process failed:', error);
        return null;
      }

      // 用户信息非必需：失败时用占位信息，保证账号入列表（后续可刷新）
      const userInfo = (data.userInfo && typeof data.userInfo === 'object'
        ? data.userInfo
        : {}) as { authorId?: string; uid?: string; avatar?: string; nickname?: string; fansCount?: number };

      const loginCookie =
        typeof data.cookie === 'string'
          ? data.cookie
          : JSON.stringify(data.cookie);

      const uid = userInfo.authorId || userInfo.uid || '';

      // 入库
      return {
        loginCookie,
        type: this.type,
        uid,
        account: uid,
        avatar: userInfo.avatar ?? '',
        nickname: userInfo.nickname ?? '小红书用户',
        fansCount: userInfo.fansCount ?? 0,
      };
    } catch (error) {
      console.error('Login process failed:', error);
      return null;
    }
  }

  async loginCheck(account: AccountModel) {
    try {
      const userInfo = await xiaohongshuService.getUserInfo(
        JSON.parse(account.loginCookie),
      );
      return {
        online: !!userInfo.authorId,
        account: {
          avatar: userInfo.avatar,
          nickname: userInfo.nickname,
          fansCount: userInfo.fansCount,
          abnormalStatus: {
            [PlatType.Xhs]: userInfo.diagnosis_status,
          },
        },
      };
    } catch (error) {
      console.error(error);
      return {
        online: false,
      };
    }
  }

  async getAccountInfo(params: IAccountInfoParams): Promise<AccountInfoTypeRV> {
    try {
      const userInfo = await xiaohongshuService.getUserInfo(params.cookies);
      // 映射为标准账号信息结构：uid 使用平台真实 authorId，
      // 登录同步后账号表写入真实 uid（替代合成占位值），满足「真实数据，无则抛弃」
      return {
        type: this.type,
        uid: userInfo.authorId || '',
        account: userInfo.authorId || '',
        avatar: userInfo.avatar || '',
        nickname: userInfo.nickname || '',
        fansCount: userInfo.fansCount ?? 0,
      };
    } catch (error) {
      console.log('-----xhs getAccountInfo error', error);

      return null;
    }
  }

  async getStatistics(account: AccountModel) {
    // 会话失效/接口异常时粉丝数返回 null（调用方保留旧值，不清零真实粉丝数），
    // 作品数仍取本地真实行数
    let fansCount: number | null = null;
    try {
      const accountInfo = await xiaohongshuService.getUserInfo(
        JSON.parse(account.loginCookie),
      );
      fansCount = accountInfo.fansCount ?? null;
    } catch (e) {
      logger.warn('[xhs-statistics] 拉取粉丝数失败（保留旧值）:', e);
    }
    // 作品数取本地作品表真实行数（视频+图文），不再写死 0
    const videoRepo = AppDataSource.getRepository(VideoModel);
    const imgTextRepo = AppDataSource.getRepository(ImgTextModel);
    const videoCount = await videoRepo.count({ where: { userId: account.userId } });
    const imgTextCount = await imgTextRepo.count({ where: { userId: account.userId } });
    return {
      fansCount,
      workCount: videoCount + imgTextCount,
    };
  }

  /**
   * 同步作品互动数据：CDP 采集小红书笔记管理页真实数据并回填本地作品表
   */
  async syncWorkStats() {
    try {
      const { collectXhsWorkStats } = await import('./xhsWorkPageDriver');
      const stats = await collectXhsWorkStats();
      if (stats.length === 0) {
        return { updated: 0, total: 0, message: '未采集到作品数据（可能未登录或页面改版）', stats: [] };
      }

      const videoRepo = AppDataSource.getRepository(VideoModel);
      const imgTextRepo = AppDataSource.getRepository(ImgTextModel);
      let updated = 0;
      for (const item of stats) {
        if (!item.dataId)
          continue;
        let target: VideoModel | ImgTextModel | null
          = await videoRepo.findOne({ where: { dataId: item.dataId } });
        if (!target) {
          target = await imgTextRepo.findOne({ where: { dataId: item.dataId } });
        }
        if (!target)
          continue;
        target.readCount = item.viewCount;
        target.likeCount = item.likeCount;
        target.commentCount = item.commentCount;
        target.forwardCount = item.shareCount;
        target.collectCount = item.collectCount;
        target.lastStatsTime = new Date();
        // 作品真实发布时间（平台时间）：始终覆盖本地值，修复发布日历假日期
        if (item.createTime) {
          target.publishTime = new Date(item.createTime * 1000);
        }
        if (target instanceof VideoModel) {
          await videoRepo.save(target);
        }
        else {
          await imgTextRepo.save(target);
        }
        updated++;
      }
      return { updated, total: stats.length, stats };
    }
    catch (e) {
      logger.error('[xhs] 同步作品互动数据失败:', e);
      return { updated: 0, total: 0, message: (e as Error).message, stats: [] };
    }
  }

  async getDashboard(account: AccountModel, time: string[] = []) {
    const res: DashboardData[] = [];
    try {
      const cookie: CookiesType = JSON.parse(account.loginCookie);
      const ret = await xiaohongshuService.getDashboardFunc(
        cookie,
        time[0],
        time[1],
      );
      if (!ret.success) throw new Error('获取三方平台数据失败');
      for (const item of ret.data) {
        res.push({
          time: item.date,
          fans: item.zhangfen,
          read: item.bofang,
          comment: item.pinglun,
          like: item.dianzan,
          forward: item.fenxiang,
          collect: 0, // TODO: 获取收藏数据
        });
      }
    } catch (error) {
      console.log('------ getDashboard wxSph ---', error);
    }

    return res;
  }

  /**
   * 搜索作品列表
   * @param account
   * @param pcursor
   * @returns
   */
  async getsearchNodeList(account: AccountModel, qe?: string, pageInfo?: any) {
    // console.log('------ getsearchNodeList xhs pageInfo---', pageInfo);
    const pageNo = pageInfo ? Number.parseInt(pageInfo.pcursor) : 0;
    // console.log('------ getsearchNodeList xhs pageNo---', pageNo);
    const pageSize = 20;

    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await xiaohongshuService.getSearchNodeList(
      CookieToString(cookie),
      qe || '',
      pageNo,
    );

    const list: WorkData[] = res.data.data.items.map((v: any) => ({
      dataId: v.id,
      readCount: v.note_card?.interact_info?.view_count,
      likeCount: v.note_card?.interact_info?.liked_count,
      collectCount: v.note_card?.interact_info?.collected_count,
      commentCount: v.note_card?.interact_info?.comment_count,
      title: v.note_card?.display_title,
      coverUrl: v.note_card?.cover.url_default || '',
      option: {
        xsec_token: v.xsec_token,
      },
      author: {
        name: v.note_card?.user?.nickname,
        avatar: v.note_card?.user?.avatar,
      },
      data: v,
    }));

    const count = res.data.data?.tags?.[0]?.notes_count || 0;
    const hasMore = res.data.data.has_more;
    return {
      list,
      pageInfo: {
        count,
        hasMore,
        pcursor: hasMore ? pageNo + 1 + '' : '',
      },
    };
  }

  /**
   * 获取作品列表
   * @param account
   * @param pcursor
   * @returns
   */
  async getWorkList(account: AccountModel, pcursor?: string) {
    const pageNo = pcursor ? Number.parseInt(pcursor) : 0;

    const pageSize = 20;

    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await xiaohongshuService.getWorks(
      CookieToString(cookie),
      pageNo,
    );

    // 兼容两种响应层级：{ data: { notes } } 与 { data: { data: { notes } } }
    const notes: any[] = res?.data?.data?.notes ?? res?.data?.notes ?? [];
    const list: WorkData[] = notes.map((v: any) => ({
      dataId: v.id,
      readCount: v.view_count,
      likeCount: v.likes,
      collectCount: v.collected_count,
      commentCount: v.comments_count,
      title: v.display_title,
      coverUrl: v.images_list[0]?.url || '',
      option: {
        xsec_token: v.xsec_token,
      },
    }));

    const count = res.data.data?.tags[0]?.notes_count || 0;
    const hasMore = count > pageSize * (pageNo + 1);
    return {
      list,
      pageInfo: {
        count,
        hasMore,
        pcursor: hasMore ? pageNo + 1 + '' : '',
      },
    };
  }

  /**
   * TODO: 未实现
   * @returns
   * @param dataId
   */
  async getWorkData(dataId: string) {
    return {
      dataId: '',
    };
  }
  async getCommentList<T>(
    account: AccountModel,
    data: WorkData,
    pcursor?: string,
  ) {
    // 冷却期内直接跳过，不再请求（减少风控压力）
    if (isCommentCooling(account.id)) {
      return {
        list: [],
        pageInfo: { count: 0, hasMore: false, pcursor: '' },
      };
    }

    // 请求间隔节流（2.5s 最小间隔，模拟真人节奏）
    const wait = COMMENT_GAP_MS - (Date.now() - lastCommentCallAt);
    if (wait > 0) await new Promise((s) => setTimeout(s, wait));
    lastCommentCallAt = Date.now();

    const cookie: CookiesType = JSON.parse(account.loginCookie);

    const res = await xiaohongshuService.getCommentList(
      cookie,
      {
        xsec_token: data.option!.xsec_token,
        id: data.dataId,
      },
      pcursor ? Number.parseInt(pcursor) : undefined,
    );

    // 错误处理（makeRequest 已返回解析后的响应体：{ code, success, msg, data }）
    if (!res || res.code !== 0) {
      console.log('----- getCommentList xhs error---', res);
      recordCommentRisk(account.id, res?.code === 300011);
      return {
        list: [],
        pageInfo: {
          count: 0,
          hasMore: false,
          pcursor: '',
        },
      };
    }

    // 成功：复位失败计数（风控状态已恢复）
    const cur = commentRisk.get(account.id);
    if (cur) {
      cur.failures = 0;
      commentRisk.set(account.id, cur);
    }

    const list: CommentData[] = [];
    for (const v of res.data?.comments ?? []) {
      const subList: CommentData[] = [];
      for (const sub of v.sub_comments) {
        subList.push({
          userId: sub.user_info.user_id,
          dataId: v.note_id,
          commentId: sub.id,
          parentCommentId: v.id,
          content: sub.content,
          likeCount: Number.parseInt(sub.like_count),
          nikeName: sub.user_info.nickname,
          headUrl: sub.user_info.image,
          subCommentList: [],
        });
      }

      list.push({
        userId: v.user_info.user_id,
        dataId: v.note_id,
        commentId: v.id,
        parentCommentId: undefined,
        content: v.content,
        likeCount: Number.parseInt(v.like_count),
        nikeName: v.user_info.nickname,
        headUrl: v.user_info.image,
        data: v,
        subCommentList: subList,
      });
    }

    return {
      list: list,
      pageInfo: {
        hasMore: res.data?.has_more,
        pcursor: res.data?.cursor,
      },
    };
  }

  /**
   * 回复评论（API 直连，无需页面驱动）
   * @param account 账号
   * @param data 作品数据（含 dataId、option.xsec_token）
   * @param commentId 被回复的评论ID
   * @param content 回复内容
   */
  async replyCommentByApi(
    account: AccountModel,
    data: WorkData,
    commentId: string,
    content: string,
    _comment?: any,
  ) {
    // 写路径同样遵守评论风控冷却：冷却期内直接返回，不撞限
    if (isCommentCooling(account.id)) {
      return { code: -1, cooled: true, msg: '评论风控冷却中，暂停回复' };
    }
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res: any = await xiaohongshuService.commentPost(
      cookie,
      data.dataId,
      content,
      commentId,
    );
    console.log(
      '[xhs-reply] 评论回复结果',
      JSON.stringify({
        code: res?.code,
        msg: res?.msg,
        toast: res?.data?.toast ?? res?.toast,
      }),
    );
    // 写入返回 300011 时与读路径共享冷却状态：
    // 下一轮评论拉取直接跳过，避免每轮重复拉取同评论重发
    if (res?.code === 300011) {
      recordCommentRisk(account.id, true);
      riskManager.reportRisk(
        account.type,
        account.id,
        '小红书评论回复 300011（Account abnormal）',
      );
    } else if (res?.code === 0) {
      recordCommentRisk(account.id, false);
      riskManager.reportSuccess(account.type, account.id);
    }
    return res;
  }

  async getCreatorCommentListByOther(
    account: AccountModel,
    data: WorkData,
    pcursor?: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await xiaohongshuService.getCommentList(cookie, {
      xsec_token: data.option!.xsec_token,
      id: data.dataId,
    });

    const list: CommentData[] = [];

    for (const v of res.data?.comments ?? []) {
      const subList: CommentData[] = [];

      for (const sub of v.sub_comments) {
        subList.push({
          userId: sub.user_info.user_id,
          dataId: v.note_id,
          commentId: sub.id,
          parentCommentId: v.id,
          content: sub.content,
          likeCount: Number.parseInt(sub.like_count),
          nikeName: sub.user_info.nickname,
          headUrl: sub.user_info.image,
          subCommentList: [],
        });
      }

      list.push({
        userId: v.user_info.user_id,
        dataId: v.note_id,
        commentId: v.id,
        parentCommentId: undefined,
        content: v.content,
        likeCount: Number.parseInt(v.like_count),
        nikeName: v.user_info.nickname,
        headUrl: v.user_info.image,
        data: v,
        subCommentList: subList,
      });
    }

    return {
      list: list,
      pageInfo: {
        hasMore: res.data?.has_more,
        pcursor: res.data?.cursor,
      },
    };
  }

  async getCreatorSecondCommentListByOther(
    account: AccountModel,
    data: WorkData,
    root_comment_id: string,
    pcursor?: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);

    const res = await xiaohongshuService.getSecondCommentList(
      cookie,
      data.dataId,
      root_comment_id,
      pcursor,
    );
    console.log('------ getCreatorSecondCommentListByOther xhs res---', res);

    const list: CommentData[] = [];

    for (const v of res.data?.comments ?? []) {
      list.push({
        userId: v.user_info.user_id,
        dataId: v.note_id,
        commentId: v.id,
        parentCommentId: undefined,
        content: v.content,
        likeCount: Number.parseInt(v.like_count),
        nikeName: v.user_info.nickname,
        headUrl: v.user_info.image,
        data: v,
        subCommentList: [],
      });
    }

    return {
      list: list,
      pageInfo: {
        hasMore: res.data?.has_more,
        pcursor: res.data?.cursor,
      },
    };
  }

  async createCommentByOther(
    account: AccountModel,
    dataId: string, // 作品ID
    content: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const ret = await xiaohongshuService.commentPost(cookie, dataId, content);
    // console.log('------ createCommentByOther xhs ---', ret);
    return ret;
  }

  async dianzanDyOther(
    account: AccountModel,
    dataId: string, // 作品ID
  ): Promise<any> {
    console.log('------ dianzanDyOther3333', dataId);
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await xiaohongshuService.likeNote(cookie, dataId);

    console.log('------ res 小红书点赞...: ', res);

    return res;
  }

  async shoucangDyOther(
    account: AccountModel,
    dataId: string, // 作品ID
  ): Promise<any> {
    console.log('------ shoucangDyOther5555', dataId);
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await xiaohongshuService.shoucangNote(cookie, dataId);

    // console.log('------ res', res);

    return res;
  }

  async replyCommentByOther(
    account: AccountModel,
    commentId: string,
    content: string,
    option: {
      dataId?: string; // 作品ID
      comment: any; // 辅助数据,原数据
    },
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const ret = await xiaohongshuService.commentPost(
      cookie,
      option.dataId!,
      content,
      commentId,
    );

    return ret;
  }

  async createComment(
    account: AccountModel,
    dataId: string, // 作品ID
    content: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const ret = await xiaohongshuService.commentPost(cookie, dataId, content);

    return false;
  }

  async replyComment(
    account: AccountModel,
    commentId: string,
    content: string,
    option: {
      dataId?: string; // 作品ID
      comment: any; // 辅助数据,原数据
    },
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const ret = await xiaohongshuService.commentPost(
      cookie,
      option.dataId!,
      content,
      commentId,
    );

    return false;
  }
  /**
   * @param params
   * @param callback
   * @returns
   */
  async videoPublish(
    params: VideoModel,
    callback: VideoCallbackType,
  ): Promise<PublishVideoResult> {
    return new Promise(async (resolve) => {
      const result = await xiaohongshuService
        .publishVideoWorkApi(
          JSON.stringify(params.cookies),
          params.videoPath,
          this.pubParamsParse(params),
          callback,
        )
        .catch((err) => {
          resolve({
            code: 0,
            msg: err,
          });
        });

      if (!result || !result.publishId)
        return resolve({
          code: 0,
          msg: '网络繁忙，请稍后重试！',
        });

      return resolve({
        code: 1,
        msg: '成功！',
        dataId: result!.publishId,
        previewVideoLink: result.shareLink,
      });
    });
  }

  async getUsers(params: IGetUsersParams) {
    const usersRes = await xiaohongshuService.getUsers(
      JSON.parse(params.account.loginCookie),
      params.keyword,
      params.page,
    );
    return {
      status: usersRes.status,
      data: usersRes?.data?.data?.user_info_dtos?.map((v) => {
        return {
          image: v.user_base_dto.image,
          id: v.user_base_dto.red_id,
          name: v.user_base_dto.user_nickname,
        };
      }),
    };
  }

  async getTopics({
    keyword,
    account,
  }: IGetTopicsParams): Promise<IGetTopicsResponse> {
    const res = await xiaohongshuService.getTopics({
      keyword,
      cookies: JSON.parse(account.loginCookie),
    });
    return {
      status: res.status,
      data: res?.data?.data?.topic_info_dtos?.map((v) => {
        return {
          id: v.id,
          name: v.name,
          view_count: v.view_num,
        };
      }),
    };
  }

  async getLocationData(params: IGetLocationDataParams) {
    const locationRes = await xiaohongshuService.getLocations({
      ...params,
      keyword: params.keywords,
      cookies: params.cookie!,
    });
    return {
      status: locationRes.status,
      data: locationRes?.data?.data?.poi_list?.map((v) => {
        return {
          name: v.name,
          simpleAddress: v.full_address,
          id: v.poi_id,
          poi_type: v.poi_type,
          latitude: v.latitude,
          longitude: v.longitude,
          city: v.city_name,
        };
      }),
    };
  }

  pubParamsParse(params: WorkDataModel): XSLPlatformSettingType {
    return {
      proxy: params.proxyIp || '',
      cover: params.coverPath || '',
      desc: params.desc,
      title: params.title,
      topicsDetail:
        params.topics?.map((v) => ({
          topicId: v,
          topicName: v,
        })) || [],
      timingTime: params.timingTime?.getTime(),
      visibility_type:
        params.visibleType === VisibleTypeEnum.Public
          ? 0
          : params.visibleType === VisibleTypeEnum.Private
            ? 1
            : 4,
      // 位置
      poiInfo: params.location
        ? {
            poiType: params.location.poi_type!,
            poiId: params.location.id,
            poiName: params.location.name,
            poiAddress: params.location.simpleAddress,
          }
        : undefined,
      // @用户
      mentionedUserInfo: params.mentionedUserInfo
        ? params.mentionedUserInfo.map((v) => {
            return {
              nickName: v.label,
              uid: `${v.value}`,
            };
          })
        : undefined,
    };
  }

  async imgTextPublish(params: ImgTextModel): Promise<PublishVideoResult> {
    return new Promise(async (resolve) => {
      const result = await xiaohongshuService
        .publishImageWorkApi(
          JSON.stringify(params.cookies),
          params.imagesPath,
          this.pubParamsParse(params),
        )
        .catch((err) => {
          resolve({
            code: 0,
            msg: err,
          });
        });

      if (!result || !result.publishId)
        return resolve({
          code: 0,
          msg: '网络繁忙，请稍后重试！',
        });

      return resolve({
        code: 1,
        msg: '成功！',
        dataId: result!.publishId,
        previewVideoLink: result.shareLink,
      });
    });
  }
}

const xhs = new Xhs();
export default xhs;
