/*
 * @Author: nevin
 * @Date: 2025-02-06 15:57:02
 * @LastEditTime: 2025-03-24 15:15:04
 * @LastEditors: nevin
 * @Description:
 */
import { AccountModel } from '../../db/models/account';
import { PlatformBase } from './PlatformBase';
import xhs from './platforms/xhs';
import douyin from './platforms/douyin';
import {
  IAccountInfoParams,
  IGetLocationDataParams,
  IGetUsersParams,
  WorkData,
} from './plat.type';
import { PublishVideoResult } from './module';
import { VideoModel } from '../../db/models/video';
import { PubItemVideo } from './pub/PubItemVideo';
import { PlatType } from '../../../commont/AccountEnum';
import { PubItemImgText } from './pub/PubItemImgText';
import { ImgTextModel } from '../../db/models/imgText';
import { EtEvent } from '../../global/event';
import { riskManager, isRiskResponse } from '../safety/riskManager';
import { quotaManager } from '../safety/quotaManager';
import { checkContent } from '../safety/contentFilter';
import { logger } from '../../global/log';
import { publishVideoViaCreator, publishImageNoteViaCreator } from './douyinCreatorPublisher';

class PlatController {
  // 所有平台
  private readonly platforms = new Map<PlatType, PlatformBase>();

  constructor() {
    this.platforms.set(PlatType.Xhs, xhs);
    this.platforms.set(PlatType.Douyin, douyin);
  }

  // 获取平台类实例
  private getPlatform(type: PlatType) {
    const platform = this.platforms.get(type);
    if (!platform) console.warn(`没有这个平台：${type}`);

    return this.platforms.get(type);
  }

  /**
   * 登录某个平台
   * @param type 平台
   * @param params 参数
   */
  public async platlogin(type: PlatType, params?: any) {
    const platform = this.platforms.get(type)!;
    const res = await platform.login(params);
    if (!res || !res.loginCookie) return null;
    // 获取账户信息
    const info = await platform.getAccountInfo({
      cookies: JSON.parse(res.loginCookie),
    });
    if (!!info) res.fansCount = info.fansCount || 0;
    return res;
  }

  /**
   * 获取平台账号信息（官方插件式登录成功后拉取昵称/粉丝等）
   */
  public async getPlatformAccountInfo(type: PlatType, cookies: any) {
    const platform = this.platforms.get(type)!;
    try {
      return await platform.getAccountInfo({ cookies });
    }
    catch {
      return null;
    }
  }

  /**
   * 取消平台登录（关闭登录窗口并结束等待）
   */
  public cancelLogin(type: PlatType) {
    const platform = this.platforms.get(type);
    platform?.cancelLogin();
  }

  /**
   * 平台登录检测
   * @param type 平台
   * @param account
   */
  public async platLoginCheck(type: PlatType, account: AccountModel) {
    const platform = this.platforms.get(type)!;
    return await platform.loginCheck(account);
  }

  /**
   * 发布视频，支持发布到多个平台
   * @param videoModels 视频记录数据
   * @param accountModels 该用户的账号记录数据
   */
  public async videoPublish(
    videoModels: VideoModel[],
    accountModels: AccountModel[],
  ) {
    // 总发布记录状态更新
    const tasks: Promise<PublishVideoResult>[] = [];
    for (const videoModel of videoModels) {
      const platform = this.getPlatform(videoModel.type);
      if (platform) {
        // 发布是最高风险操作：风控冷却中的账号直接跳过
        const risk = riskManager.canOperate(videoModel.type, videoModel.accountId);
        if (!risk.ok) {
          console.error(
            `[plat] 账号 ${videoModel.accountId} 处于风控冷却期，跳过视频发布`,
            risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
              ? `还需 ${Math.ceil((risk.waitMs || 0) / 60000)} 分钟`
              : '（严重风控，需人工处理）',
          );
          tasks.push(
            Promise.resolve({
              code: 0,
              msg: risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
                ? `账号处于风控冷却期，已自动跳过（还需约 ${Math.ceil((risk.waitMs || 0) / 60000)} 分钟）`
                : '账号处于严重风控状态，已自动跳过，请人工检查',
            }),
          );
          continue;
        }
        // 发布配额：每日上限 / 最小间隔 / 突发熔断
        const quota = quotaManager.canOperate(videoModel.type, videoModel.accountId, 'publish');
        if (!quota.ok) {
          console.error(
            `[plat] 账号 ${videoModel.accountId} 发布被配额限制跳过: ${quota.reason}`,
            quota.waitMs ? `，还需 ${Math.ceil((quota.waitMs || 0) / 60000)} 分钟` : '',
          );
          tasks.push(
            Promise.resolve({
              code: 0,
              msg: `发布被安全配额限制自动跳过：${quota.reason}`,
            }),
          );
          continue;
        }
        // 内容安全：标题/文案发布前过敏感词过滤（合法合规底线）
        const contentCheck = checkContent(
          [videoModel.title, videoModel.desc, ...(videoModel.topics || [])].join(' '),
        );
        if (!contentCheck.ok) {
          console.error(
            `[plat] 视频发布命中敏感词已拦截:`,
            contentCheck.hitWords.join('、'),
          );
          tasks.push(
            Promise.resolve({
              code: 0,
              msg: `内容命中敏感词已拦截：${contentCheck.hitWords.join('、')}，请修改后重试`,
            }),
          );
          continue;
        }
        // 抖音视频发布：官方创作页页面内引擎优先（官方 SDK 自动签名，绕开已失效的
        // 外部 bd-ticket 签名服务器），引擎失败（页面结构变化/会话过期）自动回退本地 API
        if (videoModel.type === PlatType.Douyin && videoModel.videoPath) {
          tasks.push(
            publishVideoViaCreator({
              videoPath: videoModel.videoPath,
              title: videoModel.title || '',
            })
              .then((res) => ({
                code: 1,
                msg: '发布成功！',
                dataId: res.videoId,
                previewVideoLink: res.shareLink,
              }))
              .catch(async (engineErr) => {
                logger.warn('[douyin-publish] 创作页引擎失败，回退本地 API:', engineErr);
                return pubItemVideo.publishVideo();
              })
              .then((res) => {
                if (res.code === 1) {
                  riskManager.reportSuccess(videoModel.type, videoModel.accountId);
                  quotaManager.reportOperation(videoModel.type, videoModel.accountId, 'publish');
                } else if (isRiskResponse(res.msg)) {
                  riskManager.reportRisk(
                    videoModel.type,
                    videoModel.accountId,
                    String(res.msg || '发布返回风控信号'),
                  );
                }
                return res;
              }),
          );
          continue;
        }

        const pubItemVideo = new PubItemVideo(
          accountModels.find((v) => v.id === videoModel.accountId)!,
          videoModel,
          platform,
        );

        EtEvent.emit('ET_TRACING_VIDEO_PUL', {
          accountId: videoModel.accountId,
          dataId: videoModel.dataId,
          desc: '发布成功！',
        });

        tasks.push(
          pubItemVideo.publishVideo().then((res) => {
            if (res.code === 1) {
              riskManager.reportSuccess(videoModel.type, videoModel.accountId);
              quotaManager.reportOperation(videoModel.type, videoModel.accountId, 'publish');
            } else if (isRiskResponse(res.msg)) {
              riskManager.reportRisk(
                videoModel.type,
                videoModel.accountId,
                String(res.msg || '发布返回风控信号'),
              );
            }
            return res;
          }),
        );
      }
    }
    return await Promise.all(tasks);
  }

  /**
   * 发布图文，支持发布到多个平台
   * @param imgTextModels 图文记录数据
   * @param accountModels 该用户的账号记录数据
   */
  public async imgTextPublish(
    imgTextModels: ImgTextModel[],
    accountModels: AccountModel[],
  ) {
    // 总发布记录状态更新
    const tasks: Promise<PublishVideoResult>[] = [];
    for (const videoModel of imgTextModels) {
      const platform = this.getPlatform(videoModel.type);
      if (platform) {
        const risk = riskManager.canOperate(videoModel.type, videoModel.accountId);
        if (!risk.ok) {
          console.error(
            `[plat] 账号 ${videoModel.accountId} 处于风控冷却期，跳过图文发布`,
            risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
              ? `还需 ${Math.ceil((risk.waitMs || 0) / 60000)} 分钟`
              : '（严重风控，需人工处理）',
          );
          tasks.push(
            Promise.resolve({
              code: 0,
              msg: risk.waitMs && risk.waitMs < Number.MAX_SAFE_INTEGER
                ? `账号处于风控冷却期，已自动跳过（还需约 ${Math.ceil((risk.waitMs || 0) / 60000)} 分钟）`
                : '账号处于严重风控状态，已自动跳过，请人工检查',
            }),
          );
          continue;
        }
        const quota = quotaManager.canOperate(videoModel.type, videoModel.accountId, 'publish');
        if (!quota.ok) {
          console.error(
            `[plat] 账号 ${videoModel.accountId} 图文发布被配额限制跳过: ${quota.reason}`,
            quota.waitMs ? `，还需 ${Math.ceil((quota.waitMs || 0) / 60000)} 分钟` : '',
          );
          tasks.push(
            Promise.resolve({
              code: 0,
              msg: `发布被安全配额限制自动跳过：${quota.reason}`,
            }),
          );
          continue;
        }
        const contentCheck = checkContent(
          [videoModel.title, videoModel.desc, ...(videoModel.topics || [])].join(' '),
        );
        if (!contentCheck.ok) {
          console.error(
            `[plat] 图文发布命中敏感词已拦截:`,
            contentCheck.hitWords.join('、'),
          );
          tasks.push(
            Promise.resolve({
              code: 0,
              msg: `内容命中敏感词已拦截：${contentCheck.hitWords.join('、')}，请修改后重试`,
            }),
          );
          continue;
        }
        // 抖音图文发布：官方创作页页面内引擎优先（绕开失效的 bd-ticket 签名服务器），
        // 引擎失败自动回退本地 API
        if (videoModel.type === PlatType.Douyin && Array.isArray(videoModel.imagesPath) && videoModel.imagesPath.length > 0) {
          tasks.push(
            publishImageNoteViaCreator({
              images: videoModel.imagesPath,
              title: videoModel.title || '',
              desc: videoModel.desc || '',
            })
              .then((res) => ({
                code: 1,
                msg: '发布成功！',
                dataId: res.videoId,
                previewVideoLink: res.shareLink,
              }))
              .catch(async (engineErr) => {
                logger.warn('[douyin-publish] 图文创作页引擎失败，回退本地 API:', engineErr);
                const pubItemImgText = new PubItemImgText(
                  accountModels.find((v) => v.id === videoModel.accountId)!,
                  videoModel,
                  platform,
                );
                return pubItemImgText.publishImgText();
              })
              .then((res) => {
                if (res.code === 1) {
                  riskManager.reportSuccess(videoModel.type, videoModel.accountId);
                  quotaManager.reportOperation(videoModel.type, videoModel.accountId, 'publish');
                } else if (isRiskResponse(res.msg)) {
                  riskManager.reportRisk(
                    videoModel.type,
                    videoModel.accountId,
                    String(res.msg || '图文发布返回风控信号'),
                  );
                }
                return res;
              }),
          );
          continue;
        }

        const pubItemVideo = new PubItemImgText(
          accountModels.find((v) => v.id === videoModel.accountId)!,
          videoModel,
          platform,
        );
        tasks.push(
          pubItemVideo.publishImgText().then((res) => {
            if (res.code === 1) {
              riskManager.reportSuccess(videoModel.type, videoModel.accountId);
              quotaManager.reportOperation(videoModel.type, videoModel.accountId, 'publish');
            } else if (isRiskResponse(res.msg)) {
              riskManager.reportRisk(
                videoModel.type,
                videoModel.accountId,
                String(res.msg || '图文发布返回风控信号'),
              );
            }
            return res;
          }),
        );
      }
    }
    return await Promise.all(tasks);
  }

  /**
   * 获取某个平台的话题数据
   * @param account
   * @param keyword
   */
  public async getTopic(account: AccountModel, keyword: string) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getTopics({
      keyword,
      account,
    });
  }

  /**
   * 获取某个平台的账户信息
   * @param type 平台
   * @param params 参数
   */
  public async getAccountInfo(type: PlatType, params: IAccountInfoParams) {
    const platform = this.platforms.get(type)!;
    return await platform.getAccountInfo(params);
  }

  /**
   * 获取某个平台的账户统计数据
   * @param account 账户
   */
  public async getStatistics(account: AccountModel) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getStatistics(account);
  }

  /**
   * 获取某个平台的账户面板数据
   * @param account 账户
   * @param time
   */
  public async getDashboard(account: AccountModel, time?: [string, string]) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getDashboard(account, time || []);
  }

  // 获取位置数据
  public async getLocationData(params: IGetLocationDataParams) {
    const platform = this.platforms.get(params.account!.type)!;
    return await platform.getLocationData({
      ...params,
      cookie: JSON.parse(params.account!.loginCookie),
    });
  }

  // 获取用户数据
  public async getUsers(params: IGetUsersParams) {
    const platform = this.platforms.get(params.account!.type)!;
    return await platform.getUsers(params);
  }

  /**
   * 点赞
   * @param account
   * @param dataId
   * @param option
   */
  public async dianzanDyOther(
    account: AccountModel,
    dataId: string,
    option?: any,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.dianzanDyOther(account, dataId, option);
  }

  /**
   * 获取作品列表
   * @param account
   * @param pcursor
   */
  public async shoucangDyOther(account: AccountModel, pcursor?: string) {
    const platform = this.platforms.get(account.type)!;
    return await platform.shoucangDyOther(account, pcursor);
  }

  /**
   * 获取作品列表
   * @param account
   * @param pcursor
   */
  public async getWorkList(account: AccountModel, pcursor?: string) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getWorkList(account, pcursor);
  }

  /**
   * 搜索作品列表
   * @param account
   * @param qe
   * @param pageInfo
   */
  public async getsearchNodeList(
    account: AccountModel,
    qe?: string,
    pageInfo?: any,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getsearchNodeList(account, qe, pageInfo);
  }

  /**
   * 获取评论列表
   * @param account
   * @param data
   * @param pcursor
   */
  public async getCommentList(
    account: AccountModel,
    data: WorkData,
    pcursor?: string,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getCommentList(account, data, pcursor);
  }

  /**
   * 回复评论（各平台实现：小红书 API 直连，抖音页面驱动）
   */
  public async replyComment(
    account: AccountModel,
    data: WorkData,
    commentId: string,
    content: string,
    comment?: any,
  ) {
    const platform = this.platforms.get(account.type)! as any;
    if (typeof platform.replyCommentByApi === 'function') {
      return await platform.replyCommentByApi(account, data, commentId, content, comment);
    }
    // 无 API 直连实现（如抖音走页面驱动）：返回结构化失败而非裸抛异常，
    // 调用方按普通失败处理（记录日志、计入错误统计），不中断轮询循环
    logger.warn('[plat] 平台未实现评论回复 API，跳过:', account.type);
    return { code: -2, msg: '该平台暂不支持 API 直连评论回复' };
  }

  /**
   * 获取评论列表
   * @param account
   * @param data
   * @param pcursor
   */
  public async getCreatorCommentListByOther(
    account: AccountModel,
    data: WorkData,
    pcursor?: string,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getCreatorCommentListByOther(account, data, pcursor);
  }

  // 获取合集
  public async getMixList(account: AccountModel) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getMixList(JSON.parse(account.loginCookie));
  }

  /**
   * 获取二级评论列表
   * @param account
   * @param data
   * @param root_comment_id
   * @param pcursor
   */
  public async getCreatorSecondCommentListByOther(
    account: AccountModel,
    data: WorkData,
    root_comment_id: string,
    pcursor?: string,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.getCreatorSecondCommentListByOther(
      account,
      data,
      root_comment_id,
      pcursor,
    );
  }

  /**
   * 创建评论
   * @param account
   * @param dataId
   * @param content
   */
  public async createComment(
    account: AccountModel,
    dataId: string,
    content: string,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.createComment(account, dataId, content);
  }

  /**
   * 创建评论
   * @param account
   * @param dataId
   * @param content
   */
  public async createCommentByOther(
    account: AccountModel,
    dataId: string,
    content: string,
    authorId?: string,
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.createCommentByOther(
      account,
      dataId,
      content,
      authorId,
    );
  }

  /**
   * 回复评论
   * @param account
   * @param commentId
   * @param content
   * @param option
   */
  public async replyCommentByOther(
    account: AccountModel,
    commentId: string,
    content: string,
    option: {
      dataId?: string; // 作品ID
      comment: any; // 辅助数据,原数据
      videoAuthId?: string; // 视频作者ID
    },
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.replyCommentByOther(
      account,
      commentId,
      content,
      option,
    );
  }

  /**
   * 回复评论（旧版 IPC 链路：页面驱动平台使用）
   * @param account
   * @param commentId
   * @param content
   * @param option
   */
  public async replyCommentLegacy(
    account: AccountModel,
    commentId: string,
    content: string,
    option: {
      dataId?: string; // 作品ID
      comment: any; // 辅助数据,原数据
    },
  ) {
    const platform = this.platforms.get(account.type)!;
    return await platform.replyComment(account, commentId, content, option);
  }
}

const platController = new PlatController();
export default platController;
