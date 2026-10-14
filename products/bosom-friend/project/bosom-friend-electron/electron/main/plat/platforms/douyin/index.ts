/*
 * @Author: nevin
 * @Date: 2025-02-08 11:40:45
 * @LastEditTime: 2025-03-31 09:42:25
 * @LastEditors: nevin
 * @Description: 抖音
 */
import { logger } from '../../../../global/log'
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
  DouyinPlatformSettingType,
  douyinService,
} from '../../../../plat/douyin';
import { PlatType } from '../../../../../commont/AccountEnum';
import { AccountModel } from '../../../../db/models/account';
import { VisibleTypeEnum } from '../../../../../commont/publish/PublishEnum';
import { IRequestNetResult } from '../../../../plat/requestNet';
import { VideoModel } from '../../../../db/models/video';
import { ImgTextModel } from '../../../../db/models/imgText';
import { WorkData as WorkDataModel } from '../../../../db/models/workData';
import { AppDataSource } from '../../../../db';

export type PubVideoOptin = {
  token: string;
  cover: string;
  topics: string[];
  poiInfo?: {
    poiId: string; // "6601136811005708292"
    poiName: string;
  };
};

export class Douyin extends PlatformBase {
  constructor() {
    super(PlatType.Douyin);
  }

  /** 取消登录：关闭登录窗口并结束等待 */
  override cancelLogin() {
    douyinService.cancelLogin();
  }

  /**
   * 登录
   * @returns
   */
  async login() {
    try {
      const { success, data, error } = await douyinService.loginOrView('login');
      if (!success || !data) {
        logger.info('Login process failed:', error);
        return null;
      }

      // 用户信息非必需：失败时用空对象兜底，Cookie 保存成功即可恢复运营
      let userInfo: any = {};
      try {
        userInfo = await douyinService.getUserInfo(data.cookie);
      }
      catch (userInfoError) {
        logger.warn('登录后获取用户信息失败（继续保存 Cookie）:', userInfoError);
      }

      const loginCookie =
        typeof data.cookie === 'string'
          ? data.cookie
          : JSON.stringify(data.cookie);

      return {
        loginCookie,
        loginTime: new Date(),
        type: this.type,
        uid: userInfo.authorId,
        account: userInfo.uid,
        avatar: userInfo.avatar,
        nickname: userInfo.nickname,
        token: data.localStorage,
      };
    } catch (error) {
      logger.error('Login process failed:', error);
      return null;
    }
  }

  async loginCheck(account: AccountModel) {
    const online = await douyinService.checkLoginStatus(account.loginCookie);
    // 在线时同步拉取最新账号信息（昵称/粉丝），会话复核即可刷新账号卡片
    if (online) {
      try {
        const info = await douyinService.getUserInfo(JSON.parse(account.loginCookie));
        return {
          online: true,
          account: {
            avatar: info.avatar,
            nickname: info.nickname,
            fansCount: info.fansCount,
          },
        };
      } catch {
        // 信息拉取失败不影响在线判定
      }
    }
    return {
      online,
    };
  }

  async getAccountInfo(params: IAccountInfoParams): Promise<AccountInfoTypeRV> {
    const res = await douyinService.getUserInfo(params.cookies);

    return {
      type: this.type,
      uid: res.authorId,
      account: res.authorId,
      avatar: res.avatar,
      nickname: res.nickname,
      fansCount: res.fansCount,
    };
  }

  async getStatistics(account: AccountModel) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);

    // 会话失效/接口异常时优雅降级：粉丝数回退 0，作品数仍取本地真实行数
    let fansCount = 0;
    try {
      const accountInfo = await douyinService.getUserInfo(cookie);
      fansCount = accountInfo.fansCount;
    } catch (e) {
      logger.warn('[douyin-statistics] 拉取粉丝数失败（会话可能失效）:', e);
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

  async getDashboard(account: AccountModel, time: string[] = []) {
    const res: DashboardData[] = [];
    try {
      const ret = await douyinService.getDashboardFunc(
        account.loginCookie,
        time[0],
        time[1],
      );
      if (!ret.success) throw new Error('获取三方平台数据失败');
      // console.log('@@@ret.data', ret.data)
      for (const item of ret.data) {
        res.push({
          time: item.date,
          fans: item.zhangfen,
          read: item.bofang,
          comment: item.pinglun,
          like: item.dianzan,
          forward: item.fenxiang,
          collect: 0,
        });
      }
    } catch (error) {
      logger.info('------ getDashboard wxSph ---', error);
    }

    return res.reverse();
  }

  /**
   * 获取作品列表
   * @param pageInfo
   * @returns
   */
  async getWorkList(account: AccountModel, pcursor?: string) {
    const res = await douyinService.getCreatorItems(
      JSON.parse(account.loginCookie),
      pcursor,
    );

    const list: WorkData[] = [];
    // 登录失效/接口异常时 item_info_list 可能缺失，按空列表处理，避免阻塞轮询
    const itemInfoList = res?.data?.item_info_list ?? [];
    for (const element of itemInfoList) {
      list.push({
        // 注意：item_id 是加密串，评论接口/页面驱动需要明文 aweme id（item_id_plain）
        dataId: element.item_id_plain || element.item_id,
        // 作品列表接口不返回播放/点赞等统计，互动数据由「作品管理页驱动」采集后回填
        readCount: undefined,
        likeCount: undefined,
        collectCount: undefined,
        forwardCount: undefined,
        commentCount: element.comment_count,
        income: undefined,
        title: element.title,
        desc: undefined,
        coverUrl: element.cover_image_url,
        videoUrl: undefined,
        createTime: element.create_time,
      });

      if (element.cursor) {
        pcursor = element.cursor;
      }
    }

    return {
      list: list,
      pageInfo: {
        count: res?.data?.total_count ?? list.length,
        hasMore: res?.data?.has_more ?? false,
        pcursor: pcursor,
      },
    };
  }

  /**
   * 单个作品数据：从本地作品表按 dataId 精确回读（发布回读与详情展示的数据源）。
   * 本地无记录时返回空对象，调用方按「暂无数据」处理，不伪造。
   */
  async getWorkData(dataId: string): Promise<WorkData> {
    try {
      const videoRepo = AppDataSource.getRepository(VideoModel);
      const video = await videoRepo.findOne({ where: { dataId } });
      if (video) {
        return {
          dataId: video.dataId ?? '',
          title: video.title,
          readCount: video.readCount ?? 0,
          likeCount: video.likeCount ?? 0,
          commentCount: video.commentCount ?? 0,
          forwardCount: video.forwardCount ?? 0,
          collectCount: video.collectCount ?? 0,
          createTime: video.publishTime ? new Date(video.publishTime).toISOString() : undefined,
        };
      }
      const imgTextRepo = AppDataSource.getRepository(ImgTextModel);
      const imgText = await imgTextRepo.findOne({ where: { dataId } });
      if (imgText) {
        return {
          dataId: imgText.dataId ?? '',
          title: imgText.title,
          readCount: imgText.readCount ?? 0,
          likeCount: imgText.likeCount ?? 0,
          commentCount: imgText.commentCount ?? 0,
          forwardCount: imgText.forwardCount ?? 0,
          collectCount: imgText.collectCount ?? 0,
          createTime: imgText.publishTime ? new Date(imgText.publishTime).toISOString() : undefined,
        };
      }
    } catch (e) {
      logger.warn('[douyin] getWorkData 回读失败:', e);
    }
    return {
      dataId: '',
    };
  }

  /**
   * 获取搜索作品列表
   * @param account
   * @param data
   * @param pcursor
   * @returns
   */
  async getsearchNodeList(account: AccountModel, qe: string, pageInfo?: any) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    logger.info(
      'getsearchNodeList',
      pageInfo.count,
      pageInfo.pcursor,
      pageInfo.postFirstId,
    );
    const res = await douyinService.getSearchNodeList(cookie, qe, {
      count: pageInfo.count,
      pcursor: pageInfo.pcursor,
      postFirstId: pageInfo.postFirstId,
    });

    const list: WorkData[] = [];
    logger.info('------douyin getsearchNodeList res: ', res.data.data);
    // console.log('------douyin getsearchNodeList res.data.cursor: ', res.data.cursor);
    for (const s of res.data.data) {
      const v = s.aweme_info;
      list.push({
      dataId: v.aweme_id,
        readCount: v.statistics?.play_count ?? v.statistics?.digg_count,
        likeCount: v.statistics?.digg_count,
        collectCount: v.statistics?.collect_count,
        commentCount: v.statistics?.comment_count,
        title: v.desc,
        coverUrl: v.video.cover.url_list[0] || '',
        option: {
          xsec_token: v.xsec_token || '',
        },
        author: {
          name: v.author?.nickname,
          id: v.author?.uid,
          avatar: v.author?.avatar_thumb.url_list[0],
        },
        data: v,
      });
    }

    // console.log('------douyin getsearchNodeList !!res.data.has_more^^: ', !!res.data.has_more);
    return {
      list,
      orgList: res.data,
      pageInfo: {
        count: pageInfo.pcursor,
        pcursor: res.data.cursor + '',
        hasMore: !!res.data.has_more,
      },
    };
  }

  /**
   * 获取评论列表
   * @param account
   * @param data
   * @param pcursor
   * @returns
   */
  async getCommentList(
    account: AccountModel,
    data: WorkData,
    pcursor?: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await douyinService.getCreatorCommentList(cookie, data.dataId, {
      count: pcursor ? 20 : undefined,
      cursor: pcursor || undefined,
    });

    const list: CommentData[] = [];

    for (const v of (res.data?.comment_info_list || [])) {
      const subList: CommentData[] = [];
      // 优先使用 web 评论接口已返回的回复数据（reply_comment 字段，
      // 经 getCreatorCommentList 转换为 sub_comment_list），避免依赖
      // creator 加密评论ID接口（实测明文 cid 调用会失败）
      const rawSub = (v as any).sub_comment_list || [];
      for (const element of rawSub) {
        subList.push({
          userId: element.user?.uid || '',
          dataId: data.dataId,
          commentId: String(element.cid || ''),
          content: element.text || '',
          likeCount: Number.parseInt(element.digg_count) || 0,
          nikeName: element.user?.nickname || '',
          headUrl: element.user?.avatar_thumb?.url_list?.[0] || '',
          data: element,
          subCommentList: [],
        });
      }
      // 兜底：web 接口未返回回复时，尝试 creator 回复接口
      if (subList.length === 0 && v.level === 1 && Number.parseInt(v.reply_count) > 0) {
        const res2 = await douyinService.getCreatorCommentReplyList(
          cookie,
          v.comment_id,
          {
            cursor: 0 + '',
            count: 20,
          },
        );

        if (res2.status === 200 && res2.data.status_code === 0) {
          for (const element of res2.data.comment_info_list) {
            subList.push({
              userId: element.user_info.user_id,
              dataId: data.dataId,
              commentId: element.comment_id,
              content: element.text,
              likeCount: Number.parseInt(element.digg_count),
              nikeName: element.user_info.screen_name,
              headUrl: element.user_info.avatar_url,
              data: element,
              subCommentList: [],
            });
          }
        }
      }

      list.push({
        userId: v.user_info.user_id,
        dataId: data.dataId,
        commentId: v.comment_id,
        content: v.text,
        likeCount: Number.parseInt(v.digg_count),
        nikeName: v.user_info.screen_name,
        headUrl: v.user_info.avatar_url,
        data: v,
        subCommentList: subList,
      });
    }

    return {
      list,
      pageInfo: {
        count: res.data.total_count,
        pcursor: res.data.cursor + '',
        hasMore: res.data.has_more,
      },
    };
  }

  // 其他人作品评论列表
  async getCreatorCommentListByOther(
    account: AccountModel,
    data: WorkData,
    pcursor?: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res: any = await douyinService.getCreatorCommentListByOther(
      cookie,
      data.dataId,
      {
        count: pcursor ? 20 : undefined,
        cursor: pcursor || undefined,
      },
    );

    const list: any[] = [];
    logger.info(
      '------ douyinService.getCreatorCommentListByOther',
      res.data.comments,
    );

    for (const v of res.data.comments) {
      list.push({
        userId: v.user.uid,
        dataId: v.aweme_id,
        commentId: v.cid,
        content: v.text,
        likeCount: Number.parseInt(v.digg_count),
        nikeName: v.user.nickname,
        headUrl: v.user.avatar_thumb.url_list[0],
        data: v,
        subCommentList: [],
      });
    }

    return {
      list,
      pageInfo: {
        count: res.data.total_count,
        pcursor: res.data.cursor + '',
        hasMore: res.data.has_more,
      },
    };
  }

  async dianzanDyOther(
    account: AccountModel,
    dataId: string, // 作品ID
  ): Promise<boolean> {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    try {
      const res = await douyinService.creatorDianzanOther(cookie, {
        aweme_id: dataId,
        item_type: 0,
        type: 1,
      });

      return res.status_code === 0;
    } catch (error) {
      logger.info('------ error douyin dianzanDyOther ---- ', error);
      return false;
    }
  }

  async shoucangDyOther(
    account: AccountModel,
    dataId: string, // 作品ID
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await douyinService.creatorShoucangOther(cookie, {
      aweme_id: dataId,
      action: 1,
      aweme_type: 0,
    });

    logger.info('------ res', res);

    return res;
  }

  async createCommentByOther(
    account: AccountModel,
    dataId: string, // 作品ID
    content: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    logger.info('dataIddataId????:', dataId, content);
    const res = await douyinService.creatorCommentReplyOther(cookie, {
      aweme_id: dataId,
      text: content,
      one_level_comment_rank: -1,

      // aweme_id: '7498682394024430907',
      // comment_send_celltime: 46567,
      // comment_video_celltime: 8969,
      // one_level_comment_rank: -1,
      // paste_edit_method: 'non_paste',
      // text: '调',
    });

    logger.info('-- 评论 ---- res', res);

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
    logger.info('------ replyCommentByOther1', commentId, option.dataId);

    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await douyinService.creatorCommentReplyOther(cookie, {
      aweme_id: option.dataId || '',
      reply_id: commentId,
      text: content,
      one_level_comment_rank: 1,
    });

    logger.info('------ res', res);

    return res;
  }

  async createComment(
    account: AccountModel,
    dataId: string, // 作品ID
    content: string,
  ) {
    const cookie: CookiesType = JSON.parse(account.loginCookie);
    const res = await douyinService.creatorCommentReply(cookie, {
      comment_Id: '',
      item_id: dataId,
      text: content,
    });

    return res.status === 200 && res.data.status_code === 0;
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
    try {
      const res = await douyinService.creatorCommentReply(cookie, {
        comment_Id: commentId,
        item_id: option.dataId!,
        text: content,
      });

      return res.status === 200 && res.data.status_code === 0;
    } catch (error) {
      logger.info('------ replyComment ----', error);
      return false;
    }
  }

  pubParamsParse(params: WorkDataModel): DouyinPlatformSettingType {
    const douyinParams = params.diffParams![PlatType.Douyin];
    return {
      proxyIp: params.proxyIp || '',
      userDeclare: douyinParams?.selfDeclare,
      activity: douyinParams?.activitys?.map((v) => {
        return {
          label: v.label,
          value: `${v.value}`,
        };
      }),
      hot_sentence: douyinParams?.hotPoint?.label,
      mentionedUserInfo: params.mentionedUserInfo?.map((v) => {
        return {
          nickName: v.label,
          uid: `${v.value}`,
        };
      }),
      mixInfo: params.mixInfo
        ? {
            mixId: `${params.mixInfo.value}`,
            mixName: params.mixInfo.label,
          }
        : undefined,
      title: params.title || '',
      topics: params.topics,
      caption: params.desc,
      cover: params.coverPath || '',
      timingTime: params.timingTime?.getTime(),
      // 可见性
      visibility_type:
        params.visibleType === VisibleTypeEnum.Public
          ? 0
          : params.visibleType === VisibleTypeEnum.Private
            ? 1
            : 2,
      // 地址
      ...(params.location
        ? {
            poiInfo: {
              poiId: `${params.location.id}`,
              poiName: params.location.name,
            },
          }
        : {}),
    };
  }

  async videoPublish(
    params: VideoModel,
    callback: VideoCallbackType,
  ): Promise<PublishVideoResult> {
    return new Promise(async (resolve) => {
      const result = await douyinService
        .publishVideoWorkApi(
          JSON.stringify(params.cookies),
          params?.token,
          params.videoPath!,
          this.pubParamsParse(params),
          callback,
        )
        .catch((e) => {
          resolve({
            code: 0,
            msg: e,
          });
        });
      if (!result.publishId)
        return resolve({
          code: 0,
          msg: '网络繁忙，请稍后重试',
        });

      return resolve({
        code: 1,
        msg: '发布成功',
        dataId: result.publishId,
        previewVideoLink: result.shareLink,
      });
    });
  }

  async getTopics({ keyword }: IGetTopicsParams): Promise<IGetTopicsResponse> {
    const topicsRes = await douyinService.getTopics({ keyword });
    return {
      status: this.getCode(topicsRes),
      data: topicsRes?.data?.sug_list?.map((v) => {
        return {
          id: v.cid,
          name: v.cha_name,
          view_count: v.view_count,
        };
      }),
    };
  }

  async getUsers(params: IGetUsersParams) {
    const usersRes = await douyinService.getUsers(
      JSON.parse(params.account.loginCookie),
      params.keyword,
      params.page,
    );

    return {
      status: this.getCode(usersRes),
      data: usersRes?.data?.user_list?.map((v) => {
        return {
          image: 'https://p26.douyinpic.com/aweme/' + v.avatar_thumb.uri,
          id: v.uid,
          name: v.nickname,
          unique_id: v.unique_id,
          des: '',
          follower_count: v.follower_count,
        };
      }),
    };
  }

  async getLocationData(params: IGetLocationDataParams) {
    const locationRes = await douyinService.getLocation({
      ...params,
      cookie: params.cookie!,
    });

    return {
      status: this.getCode(locationRes),
      data: locationRes?.data?.poi_list?.map((v) => {
        return {
          name: v.poi_name,
          simpleAddress: v.simple_address_str,
          id: v.poi_id,
          latitude: v.poi_latitude,
          longitude: v.poi_longitude,
          city: v.address_info.city,
        };
      }),
    };
  }

  async imgTextPublish(params: ImgTextModel): Promise<PublishVideoResult> {
    return new Promise(async (resolve) => {
      const result = await douyinService
        .publishImageWorkApi(
          JSON.stringify(params.cookies),
          params?.token,
          params.imagesPath,
          this.pubParamsParse(params),
        )
        .catch((e) => {
          resolve({
            code: 0,
            msg: e,
          });
        });
      if (!result?.publishId)
        return resolve({
          code: 0,
          msg: '网络繁忙，请稍后重试',
        });

      return resolve({
        code: 1,
        msg: '发布成功',
        dataId: result.publishId,
        previewVideoLink: result.shareLink,
      });
    });
  }

  getCreatorSecondCommentListByOther(
    account: AccountModel,
    data: WorkData,
    root_comment_id: string,
    pcursor?: string,
  ): Promise<any> {
    return Promise.resolve(undefined);
  }

  getCode(res: IRequestNetResult<any>) {
    return res?.data?.status_code === 8 || res?.data?.status_code === 7
      ? 401
      : res?.status;
  }

  async getMixList(cookie: CookiesType) {
    const mixRes = await douyinService.getMixList(cookie);
    return {
      status: this.getCode(mixRes),
      data: mixRes?.data.mix_list?.map((v) => {
        return {
          id: v.mix_id,
          name: v.mix_name,
          coverImg: v.cover_url.url_list[0],
          feedCount: v.statis.updated_to_episode,
        };
      }),
    };
  }

  /**
   * 同步作品真实互动数据：页面驱动采集作品管理页 → 按 dataId 回填本地作品表
   * 返回更新条数；无作品数据或采集失败返回 0。
   */
  async syncWorkStats(): Promise<{
    updated: number;
    total: number;
    message?: string;
    stats: Array<{
      dataId: string;
      title?: string;
      createTime?: number;
      viewCount: number;
      likeCount: number;
      commentCount: number;
      shareCount: number;
      collectCount: number;
    }>;
  }> {
    try {
      const { collectDouyinWorkStats } = await import('./douyinWorkPageDriver');
      const stats = await collectDouyinWorkStats();
      if (stats.length === 0) {
        return { updated: 0, total: 0, message: '未采集到作品数据（可能未登录或页面结构变化）', stats: [] };
      }

      const videoRepo = AppDataSource.getRepository(VideoModel);
      const imgTextRepo = AppDataSource.getRepository(ImgTextModel);
      let updated = 0;
      for (const item of stats) {
        if (!item.dataId) continue;
        let target: VideoModel | ImgTextModel | null =
          await videoRepo.findOne({ where: { dataId: item.dataId } });
        if (!target) {
          target = await imgTextRepo.findOne({ where: { dataId: item.dataId } });
        }
        if (!target) continue;
        target.readCount = item.viewCount;
        target.likeCount = item.likeCount;
        target.commentCount = item.commentCount;
        target.forwardCount = item.shareCount;
        target.collectCount = item.collectCount;
        target.lastStatsTime = new Date();
        // 作品真实发布时间（平台 create_time）：始终以平台真实时间为准覆盖本地值，
        // 修复发布日历日期（此前本地 publishTime 可能是提交/同步时间冒充的假日期）
        if (item.createTime) {
          target.publishTime = new Date(item.createTime * 1000);
        }
        if (target instanceof VideoModel) {
          await videoRepo.save(target);
        } else {
          await imgTextRepo.save(target);
        }
        updated++;
      }
      return { updated, total: stats.length, stats };
    } catch (e) {
      logger.error('[douyin] 同步作品互动数据失败:', e);
      return { updated: 0, total: 0, message: (e as Error).message, stats: [] };
    }
  }
}

const douyin = new Douyin();
export default douyin;
