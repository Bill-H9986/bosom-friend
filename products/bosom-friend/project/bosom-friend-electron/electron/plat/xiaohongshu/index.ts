import { screen, BrowserWindow, net, session } from 'electron';
import * as crypto from 'crypto';
import sizeOf from 'image-size';
import { CommonUtils } from '../../util/common';
import { FileUtils } from '../../util/file';
import { CookieToString, getFileContent } from '../utils';
import requestNet from '../requestNet';
import {
  IXHSGetWorksResponse,
  IXHSLocationResponse,
  IXHSTopicsResponse,
  XhsCommentListResponse,
  XhsCommentPostResponse,
  XiaohongshuApiResponse,
} from './xiaohongshu.type';
import { RetryWhile } from '../../../commont/utils';
import { logger } from '../../global/log';
import { signInPage } from '../../main/plat/xhsInPageSigner';
import { publishImageNoteViaCreator, publishVideoNoteViaCreator } from '../../main/plat/xhsCreatorPublisher';

export type XSLPlatformSettingType = {
  // 标题
  title?: string;
  // 描述
  desc?: string;
  // 定时发布
  timingTime?: number;
  // @用户
  mentionedUserInfo?: {
    nickName: string;
    uid: string;
  }[];
  // 话题
  topicsDetail?: {
    topicId: string;
    topicName: string;
  }[];
  // 位置
  poiInfo?: {
    poiType: number;
    poiId: string;
    poiName: string;
    poiAddress: string;
  };
  cover: string;
  // 0 公共 1 私密 4 好友
  visibility_type: 0 | 1 | 4;
  proxy: string;
};

const esec_token = 'ABrmhLmsdmsu9bCQ80qvGPN2CYSjEqwi5G1l2dirNUjaw%3D';

export class XiaohongshuService {
  private defaultUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Zhiyin/0.8.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';
  private loginUrl = 'https://creator.xiaohongshu.com/';
  private loginUrlHome = 'https://www.xiaohongshu.com/';
  private getUserInfoUrl =
    'https://edith.xiaohongshu.com/api/sns/web/v2/user/me';
  private getDashboardUrl =
    'https://creator.xiaohongshu.com/api/galaxy/v2/creator/datacenter/account/base';
  private getFansInfoUrl =
    'https://creator.xiaohongshu.com/api/galaxy/creator/home/personal_info';
  private getUploadPermitUrl =
    'https://creator.xiaohongshu.com/api/media/v1/upload/web/permit';
  private postCreateVideoUrl =
    'https://edith.xiaohongshu.com/web_api/sns/v2/note';
  private fileBlockSize = 5242880;
  private cookieCheckField = 'access-token';
  private cookieIntervalList: { [key: string]: NodeJS.Timeout } = {};
  private prev_web_session = '';
  private win?: BrowserWindow;
  private callback?: (progress: number, msg?: string) => void;

  /**
   * 授权|预览
   */
  async loginOrView(
    authModel: 'login' | 'view',
    cookies?: any,
  ): Promise<{
    success: boolean;
    data?: { cookie: any; userInfo: any };
    error?: string;
  }> {
    try {
      const winRes = await this.createAuthorizationWindow(
        authModel === 'view' ? cookies : null,
      );
      const { winContentsId, partition } = winRes;
      const newCookies = await this.filterCookie(winContentsId, partition);

      // 用户信息非必需：获取失败用空对象兜底，Cookie 保存成功即可入账号列表
      let userInfo: any = {};
      try {
        userInfo = await this.getUserInfo(newCookies);
      }
      catch (userInfoError) {
        console.warn('获取小红书用户信息失败（继续保存 Cookie）:', userInfoError);
        userInfo = {};
      }

      if (authModel === 'login') {
        const winBrowserWindow = BrowserWindow.fromId(winContentsId);
        winBrowserWindow?.close();
        this.prev_web_session = '';
      }

      const result = {
        success: true,
        data: {
          cookie: newCookies,
          userInfo: userInfo,
        },
      };
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Login failed',
      };
    }
  }

  /**
   * 创建授权窗口
   */
  private async createAuthorizationWindow(cookies: any = null) {
    // 生成随机partition
    const partition = Date.now().toString();

    // 获取屏幕尺寸
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    // 创建窗口
    const win = new BrowserWindow({
      width: Math.ceil(width * 0.8),
      height: Math.ceil(height * 0.8),
      show: false,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
        partition: partition,
      },
    });
    // 尽早登记窗口引用，取消登录时可直接关闭
    this.win = win;
    win.show();

    // 设置用户代理
    win.webContents.setUserAgent(this.defaultUserAgent);
    this.prev_web_session = '';

    // 如果有cookies，设置cookies

    // 直达创作者登录页：一次扫码完成登录（无需先在发现页扫码再跳转）
    await win.loadURL(`${this.loginUrl}login?source=official`);

    return {
      winContentsId: win.id,
      partition,
    };
  }

  /**
   * 取消登录：关闭授权窗口并结束等待（窗口销毁后 filterCookie 自然 reject）
   */
  public cancelLogin(): void {
    this.clearCookieIntervals();
    if (this.win && !this.win.isDestroyed()) {
      this.win.close();
    }
    this.win = undefined;
  }

  /**
   * Filter and monitor cookies until login is detected
   */
  private async filterCookie(
    winContentsId: number,
    partition: string,
  ): Promise<Electron.Cookie[]> {
    return new Promise((resolve, reject) => {
      const ses = session.fromPartition(partition);

      let settled = false;
      const finish = (error?: Error) => {
        if (settled)
          return;
        settled = true;
        if (this.cookieIntervalList[winContentsId]) {
          clearInterval(this.cookieIntervalList[winContentsId]);
          delete this.cookieIntervalList[winContentsId];
        }
        if (error)
          reject(error);
      };

      // 检查创作者域 access-token cookie（登录页直达，一次扫码即完成）
      const check = async (): Promise<boolean> => {
        try {
          const cookies = await ses.cookies.get({ url: this.loginUrl });
          const alreadyLogin = cookies.some(
            (cookie) =>
              cookie.name.includes(this.cookieCheckField) && cookie.value !== '',
          );
          if (alreadyLogin) {
            finish();
            resolve(cookies);
            return true;
          }
          return false;
        }
        catch (error) {
          finish(new Error('获取网站cookie失败'));
          return true;
        }
      };

      // 轮询兜底
      this.cookieIntervalList[winContentsId] = setInterval(() => {
        void check();
      }, 1500);

      // 页面跳转后立即检查（扫码成功跳转即检测，无需等下一轮轮询）
      this.win?.webContents.on('did-navigate', () => {
        void check();
      });

      // 窗口关闭 = 取消登录：立即结束等待
      this.win?.webContents.once('destroyed', () => {
        finish(new Error('登录窗口已关闭'));
      });
    });
  }

  /**
   * Cleanup method to clear any remaining intervals
   */
  private clearCookieIntervals() {
    Object.entries(this.cookieIntervalList).forEach(([winId, interval]) => {
      clearInterval(interval as any);
      delete this.cookieIntervalList[winId];
    });
  }

  /**
   * Override class destructor to ensure cleanup
   */
  public destroy() {
    this.clearCookieIntervals();
  }

  /**
   * 获取用户信息
   */
  public async getUserInfo(cookies: Electron.Cookie[]) {
    const cookieString = cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');

    // /api/sns/web 系列接口必须带 X-S/X-T 签名，否则即使浏览器会话有效也一律 406，
    // 导致系统永远判定「未登录」：登录窗口反复弹出、账号永远离线、自动接待与发布全部假死。
    const userInfoReverse: any = await this.getReverseResult({
      url: '/api/sns/web/v2/user/me',
      a1: CookieToString(cookies),
    });

    const userInfo = await this.makeRequest(
      this.getUserInfoUrl,
      {
        method: 'GET',
        headers: {
          Cookie: cookieString,
          Referer: this.loginUrlHome,
          Origin: this.loginUrlHome,
          'X-S': userInfoReverse['X-s'],
          'X-T': userInfoReverse['X-t'],
        },
      },
      '',
    );

    const fansInfo = await this.makeRequest(
      this.getFansInfoUrl,
      {
        method: 'GET',
        headers: {
          Cookie: cookieString,
          Referer: this.loginUrl,
        },
      },
      '',
    );

    return {
      authorId: userInfo.data.user_id || '',
      nickname: userInfo.data.nickname || '',
      avatar: userInfo.data.imageb || '',
      fansCount: fansInfo.data.fans_count || 0,
      diagnosis_status: fansInfo.data.diagnosis_status,
    };
  }

  /**
   * 获取账户数据
   */
  public async getDashboardFunc(
    cookies: Electron.Cookie[],
    startDate?: string,
    endDate?: string,
  ) {
    // 初始化cookie
    const cookieString = CommonUtils.convertCookieToJson(cookies);

    // 获取cookie_a1
    const cookieObject = cookies;
    let cookie_a1 = null;
    for (const cookieItem of cookieObject) {
      if (cookieItem.name === 'a1') {
        cookie_a1 = cookieItem.value;
        break;
      }
    }

    const reverseRes: any = await this.getReverseResult({
      url: '/api/galaxy/v2/creator/datacenter/account/base',
      a1: cookie_a1,
    });

    const userInfo = await this.makeRequest(
      this.getDashboardUrl,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Cookie: cookieString,
          Referer: 'https://creator.xiaohongshu.com/statistics/account',
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.75 Safari/537.36 Edg/100.0.1185.36',
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
      },
      '',
    );

    if (userInfo.code == 0) {
      if (startDate && endDate) {
        // 处理30天的数据
        const dataList = [];
        const startTimestamp = new Date(startDate).getTime();
        const endTimestamp = new Date(endDate).getTime() + 1;

        // 获取所有列表数据
        const rise_fans_list = userInfo.data.thirty.rise_fans_list || [];
        const view_list = userInfo.data.thirty.view_list || [];
        const comment_list = userInfo.data.thirty.comment_list || [];
        const like_list = userInfo.data.thirty.like_list || [];
        const home_view_list = userInfo.data.thirty.home_view_list || [];

        // 创建日期映射
        const dateMap: { [key: string]: any } = {};

        // 处理所有类型的数据
        [
          { list: rise_fans_list, key: 'zhangfen' },
          { list: view_list, key: 'bofang' },
          { list: comment_list, key: 'pinglun' },
          { list: like_list, key: 'dianzan' },
          { list: rise_fans_list, key: 'fenxiang' },
          { list: home_view_list, key: 'zhuye' },
        ].forEach(({ list, key }) => {
          list.forEach((item: any) => {
            const timestamp = item.date;
            // 检查日期是否在范围内
            if (timestamp >= startTimestamp && timestamp <= endTimestamp) {
              if (!dateMap[timestamp]) {
                dateMap[timestamp] = {
                  date: new Date(timestamp).toISOString().split('T')[0],
                  zhangfen: 0,
                  bofang: 0,
                  pinglun: 0,
                  dianzan: 0,
                  fenxiang: 0,
                  zhuye: 0,
                };
              }
              dateMap[timestamp][key] = item.count;
            }
          });
        });

        // 转换为数组并排序
        const sortedData = Object.values(dateMap).sort(
          (a: any, b: any) =>
            new Date(b.date).getTime() - new Date(a.date).getTime(),
        );

        return {
          success: true,
          data: sortedData,
        };
      } else {
        // 保持原有的单日数据逻辑
        const data = {
          zhangfen: userInfo.data.seven.rise_fans_list[0].count,
          bofang: userInfo.data.seven.view_list[0].count,
          pinglun: userInfo.data.seven.comment_list[0].count,
          dianzan: userInfo.data.seven.like_list[0].count,
          fenxiang: userInfo.data.seven.rise_fans_list[0].count,
          zhuye: userInfo.data.seven.home_view_list[0].count,
        };

        return {
          success: true,
          data: [data],
        };
      }
    } else {
      return {
        success: false,
        data: userInfo,
      };
    }
  }

  /**
   * 通用请求方法（Node fetch 传输）
   *
   * Electron net.request 对本域名请求出现 ERR_FAILED（网络栈层失败且不可达），
   * 改用主进程 Node fetch：API 本身可达（验证 200/401），携带浏览器 UA 与 Cookie 即可。
   * 写操作（发布）仍需在页面内由官方引擎签名执行，此处仅用于读接口。
   */
  private async makeRequest(
    url: string,
    options: any,
    proxy: string,
  ): Promise<any> {
    const headers: Record<string, string> = {
      ...(options.headers || {}),
      'User-Agent': this.defaultUserAgent,
    }
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      // 已是字符串的 body 原样发送，避免双重序列化（曾导致签名与请求体不匹配 406）
      body: options.data
        ? (typeof options.data === 'string' ? options.data : JSON.stringify(options.data))
        : undefined,
      signal: AbortSignal.timeout(15000),
    })
    const text = await response.text()
    let data: any = text
    try {
      data = JSON.parse(text)
    }
    catch {
      // 非 JSON 响应原样返回
    }
    if (!response.ok) {
      throw new Error(`xhs API ${response.status}: ${text.slice(0, 200)}`)
    }
    return data
  }

  /**
   * 获取上传许可证
   * @param cookieString
   * @param scene
   */
  async getUploadPermit(cookieString: string, scene: string, proxy: string) {
    return new Promise(async (resolve, reject) => {
      try {
        const permitRes = await this.makeRequest(
          this.getUploadPermitUrl +
            `?biz_name=spectrum&scene=${scene}&file_count=1&version=1&source=web`,
          {
            method: 'GET',
            headers: {
              Cookie: cookieString,
              Referer: this.loginUrl,
            },
          },
          proxy,
        );

        if (permitRes.code !== 0) {
          reject('获取上传许可证失败,失败原因:' + permitRes.msg);
        }

        const uploadTempPermits = permitRes.data.uploadTempPermits;
        resolve(uploadTempPermits);
      } catch (err: any) {
        let errorMessage;
        if (err && err.message) {
          errorMessage = err.message;
        } else if (err) {
          errorMessage = err;
        } else {
          errorMessage = '未知';
        }
        reject('获取上传许可证失败,失败原因:' + errorMessage);
      }
    });
  }

  /**
   * 上传文件到远程服务器
   * @param url 上传地址
   * @param fileContent 文件内容
   * @param headers 请求头
   * @param proxy
   */
  private async uploadFile(
    url: string,
    fileContent: Buffer,
    headers: any,
    proxy: string,
  ): Promise<any> {
    // requestNet 在 xhs 环境下不可靠，统一迁移 fetch（原始 PUT 二进制上传）；
    // 返回 Response，由调用方读取 headers 中的预览地址
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: new Uint8Array(fileContent),
    });
    if (!res.ok) {
      throw new Error('xhs upload HTTP ' + res.status);
    }
    return res;
  }

  /**
   * 上传封面文件
   * @param cookieString
   * @param filePath
   */
  async uploadCoverFile(
    cookieString: string,
    filePath: string,
    proxy: string,
  ): Promise<{
    coverUploadFileId: string;
    coverDimensions: any;
    remotePreviewUrl: string;
  }> {
    return new Promise(async (resolve, reject) => {
      try {
        // 获取文件上传许可证
        const uploadPermit: any = await this.getUploadPermit(
          cookieString,
          'image',
          proxy,
        );
        const coverUploadFileId = uploadPermit[0].fileIds[0];
        const uploadAddr = uploadPermit[0].uploadAddr;
        const uploadToken = uploadPermit[0].token;
        const uploadBaseUrl = `https://${uploadAddr}/${coverUploadFileId}`;

        // 获取文件内容
        const fileContent = await getFileContent(filePath);

        // 获取宽高信息
        const coverDimensions = sizeOf(fileContent);

        // 直接上传
        let uploadRes = await this.uploadFile(
          uploadBaseUrl,
          fileContent,
          {
            Referer: this.loginUrl,
            'X-Cos-Security-Token': uploadToken,
          },
          proxy,
        );

        const previewUrl = uploadRes.headers.get('x-ros-preview-url');

        if (!previewUrl) {
          reject('上传封面失败,失败原因:未获取到previewUrl');
          return;
        }
        const remotePreviewUrl = previewUrl;

        // 上传成功,返回结果
        resolve({
          coverUploadFileId,
          remotePreviewUrl,
          coverDimensions,
        });
      } catch (err: any) {
        let errorMessage;
        if (err && err.message) {
          errorMessage = err.message;
        } else if (err) {
          errorMessage = err;
        } else {
          errorMessage = '未知';
        }
        reject('上传封面失败,失败原因:' + errorMessage);
      }
    });
  }

  /**
   * 文本响应专用请求方法
   */
  private async makeTextRequest(url: string, options: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: options.method,
        url: url,
        headers: options.headers,
      });

      // 发送请求体
      if (options.data) {
        request.write(
          typeof options.data === 'string'
            ? options.data
            : JSON.stringify(options.data),
        );
      }

      request.on('response', (response) => {
        let data = '';
        response.on('data', (chunk) => {
          data += chunk;
        });
        response.on('end', () => {
          resolve({
            data,
            headers: response.headers,
            status: response.statusCode,
          });
        });
      });

      request.on('error', (error) => {
        console.error('Request error:', error);
        reject(error);
      });
      request.end();
    });
  }

  /**
   * 上传视频文件
   * @param cookieString
   * @param filePath
   * @param filePartInfo
   * @param fileInfo
   */
  private async uploadVideoFile(
    cookieString: string,
    filePath: string,
    filePartInfo: any,
    fileInfo: any,
    proxy: string,
  ): Promise<{
    uploadFileId: string;
    remotePreviewUrl: string;
    remoteVideoId: string;
  }> {
    return new Promise(async (resolve, reject) => {
      try {
        // 获取文件上传许可证
        const uploadPermit: any = await this.getUploadPermit(
          cookieString,
          'video',
          proxy,
        );
        const uploadFileId = uploadPermit[0].fileIds[0];
        const uploadAddr = uploadPermit[0].uploadAddr;
        const uploadToken = uploadPermit[0].token;
        const uploadBaseUrl = `https://${uploadAddr}/${uploadFileId}`;
        let remotePreviewUrl = '';
        let remoteVideoId = '';

        // 开始上传文件
        if (filePartInfo.blockInfo?.length === 1) {
          // 获取文件内容
          const fileContent = await FileUtils.getFilePartContent(
            filePath,
            0,
            filePartInfo.fileSize - 1,
          );
          // 直接上传
          let uploadRes = await this.uploadFile(
            uploadBaseUrl,
            fileContent,
            {
              'Content-Type': fileInfo.mimeType,
              Referer: this.loginUrl,
              'X-Cos-Security-Token': uploadToken,
            },
            proxy,
          );

          uploadRes = uploadRes.headers;
          if (
            !uploadRes.hasOwnProperty('x-ros-preview-url') ||
            !uploadRes.hasOwnProperty('x-ros-video-id')
          ) {
            reject('上传视频失败,失败原因:未获取到videoId');
            return;
          }
          remotePreviewUrl = uploadRes['x-ros-preview-url'];
          remoteVideoId = uploadRes['x-ros-video-id'];
        } else {
          // 获取分片上传ID
          const uploadIdRes = await this.makeTextRequest(
            uploadBaseUrl + '?uploads',
            {
              method: 'POST',
              headers: {
                'Content-Type': fileInfo.mimeType,
                Referer: this.loginUrl,
                'X-Cos-Security-Token': uploadToken,
              },
            },
          );

          if (CommonUtils.isJsonString(uploadIdRes.data)) {
            const parsedRes = JSON.parse(uploadIdRes.data);
            reject('上传视频失败,失败原因:获取上传id失败:' + parsedRes.msg);
            return;
          }

          const parsedXml = (await CommonUtils.xml2json(uploadIdRes.data)) as {
            InitiateMultipartUploadResult: {
              UploadId: string[];
            };
          };
          const uploadId =
            parsedXml.InitiateMultipartUploadResult.UploadId[0] ?? '';
          if (uploadId === '') {
            reject('上传视频失败,失败原因:获取上传id失败');
            return;
          }

          // 分片上传文件
          const uploadPartInfo: any[] = [];

          for (const i in filePartInfo.blockInfo) {
            if (this.callback)
              this.callback(
                50,
                `上传视频（${i}/${filePartInfo.blockInfo.length}）`,
              );
            const isSuccess = await RetryWhile(async () => {
              const chunkStart =
                i === '0' ? 0 : filePartInfo.blockInfo[parseInt(i) - 1];
              const chunkEnd = filePartInfo.blockInfo[i] - 1;
              const chunkContent = await FileUtils.getFilePartContent(
                filePath,
                chunkStart,
                chunkEnd,
              );

              // 开始上传
              const uploadPartRes = await this.uploadFile(
                uploadBaseUrl +
                  `?uploadId=${uploadId}&partNumber=${parseInt(i) + 1}`,
                chunkContent,
                {
                  Referer: this.loginUrl,
                  'X-Cos-Security-Token': uploadToken,
                },
                proxy,
              );

              const headers = uploadPartRes.headers;
              if (!headers.hasOwnProperty('etag') || headers['etag'] === '') {
                return false;
              }

              // 分片上传成功
              uploadPartInfo.push({
                Part: {
                  PartNumber: parseInt(i) + 1,
                  ETag: headers['etag'],
                },
              });
              return true;
            }, 3);

            if (!isSuccess) {
              reject('上传视频失败,失败原因:上传分片失败');
              break;
            }
          }

          // 合并分片
          const completeXml = await CommonUtils.json2xml(uploadPartInfo);
          const completeRes = await this.makeTextRequest(
            uploadBaseUrl + `?uploadId=${uploadId}`,
            {
              method: 'POST',
              headers: {
                Referer: this.loginUrl,
                'X-Cos-Security-Token': uploadToken,
                'Content-Type': 'application/xml',
              },
              data: completeXml,
            },
          );

          if (CommonUtils.isJsonString(completeRes.data)) {
            const parsedRes = JSON.parse(completeRes.data);
            reject('上传视频失败,失败原因:合并分片失败:' + parsedRes.msg);
            return;
          }

          const headers = completeRes.headers;
          if (
            !headers.hasOwnProperty('x-ros-preview-url') ||
            !headers.hasOwnProperty('x-ros-video-id')
          ) {
            reject('上传视频失败,失败原因:未获取到videoId');
            return;
          }

          remotePreviewUrl = headers['x-ros-preview-url'];
          remoteVideoId = headers['x-ros-video-id'];
        }

        // 上传成功,返回结果
        resolve({
          uploadFileId: uploadFileId,
          remotePreviewUrl: remotePreviewUrl,
          remoteVideoId: remoteVideoId,
        });
      } catch (err: any) {
        let errorMessage;
        if (err && err.message) {
          errorMessage = err.message;
        } else if (err) {
          errorMessage = err;
        } else {
          errorMessage = '未知';
        }
        reject('上传视频失败,失败原因:' + errorMessage);
      }
    });
  }

  /**
   * 图文作品发布
   * @param cookies
   * @param tokens
   * @param imagePath
   * @param platformSetting
   */
  async publishImageWorkApi(
    cookies: string,
    imagePath: string[],
    platformSetting: XSLPlatformSettingType,
  ): Promise<{
    publishTime: number;
    publishId: string;
    shareLink: string;
  }> {
    console.log('小红书图文发布最初发布参数：', {
      imagePath,
      platformSetting,
    });
    return new Promise(async (resolve, reject) => {
      try {
        // 首选官方创作页引擎发布：签名由小红书官方前端维护，主进程直发持续 406 的
        // 场景由页面内引擎彻底绕开；失败时回退到下方自拼签名 API 流程。
        const localImages = imagePath.filter((p) => !p.startsWith('http'));
        if (localImages.length > 0) {
          try {
            const creatorResult = await publishImageNoteViaCreator({
              images: localImages,
              title: platformSetting.title ?? '',
              desc: platformSetting.desc ?? '',
              // 话题标签传入官方编辑器（此前被丢弃，pubParamsParse 的 topicsDetail 白做）
              topics: (platformSetting.topicsDetail || [])
                .map((t) => t.topicName || t.topicId)
                .filter((t): t is string => !!t),
            });
            console.log('小红书图文发布（官方引擎）成功：', creatorResult);
            resolve({
              publishTime: Math.floor(Date.now() / 1000),
              publishId: creatorResult.noteId,
              shareLink: creatorResult.shareLink,
            });
            return;
          } catch (creatorError) {
            console.warn(
              '小红书官方创作页发布失败，回退 API 发布:',
              creatorError,
            );
          }
        }
        // 初始化cookie
        const cookieString = CommonUtils.convertCookieToJson(cookies);
        // 上传图片
        const uploadImgRet = [];
        for (const imgUrl of imagePath) {
          // 上传图片, 获取远程Url
          const imgRet = await this.uploadCoverFile(
            cookieString,
            imgUrl,
            platformSetting.proxy,
          );
          // 添加到成功列表
          uploadImgRet.push(imgRet);
        }
        // 获取cookie_a1
        const cookieObject = JSON.parse(cookies);
        let cookie_a1 = null;
        for (const cookieItem of cookieObject) {
          if (cookieItem.name === 'a1') {
            cookie_a1 = cookieItem.value;
            break;
          }
        }
        // 创建作品
        const uploadResult = {
          imageList: uploadImgRet,
        };
        console.log('小红书图文发布最终发布参数：', {
          uploadResult,
          platformSetting,
        });
        const { shareLink, publishId } = (await this.postCreateVideo(
          cookieString,
          cookie_a1,
          'image',
          uploadResult,
          platformSetting,
          platformSetting.proxy,
        )) as any;
        // 返回信息
        resolve({
          publishTime: Math.floor(Date.now() / 1000),
          publishId: publishId,
          shareLink: shareLink,
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 创建视频作品
   * @param cookieString
   * @param cookie_a1
   * @param publishType
   * @param uploadResult {uploadFileId, uploadCoverId, coverDimensions, fileInfo}
   * @param platformSetting
   * @param proxy
   * @returns {Promise<unknown>}
   */
  async postCreateVideo(
    cookieString: string,
    cookie_a1: string,
    publishType: 'video' | 'image',
    uploadResult: any,
    platformSetting: any,
    proxy: string,
  ) {
    return new Promise(async (resolve, reject) => {
      try {
        let xhs_video_info = null;
        let xhs_image_info = null;
        // 如果是发布视频,则需要获取视频元信息
        if (publishType === 'video') {
          // 获取视频|音频元信息
          let videoInfos = null;
          let audioInfos = null;
          for (const info of uploadResult.fileInfo.streams) {
            if (
              info.hasOwnProperty('codec_type') &&
              info.codec_type === 'video'
            ) {
              videoInfos = info;
            }
            if (
              info.hasOwnProperty('codec_type') &&
              info.codec_type === 'audio'
            ) {
              audioInfos = info;
            }
          }
          if (!videoInfos || !audioInfos) {
            reject('创建作品失败,失败原因:获取视频、音频元信息失败!');
            return;
          }
          // 拼凑视频发布参数
          xhs_video_info = {
            fileid: uploadResult.uploadFileId,
            file_id: uploadResult.uploadFileId,
            format_width: videoInfos.width,
            format_height: videoInfos.height,
            video_preview_type:
              videoInfos.height > videoInfos.width
                ? 'full_vertical_screen'
                : '',
            composite_metadata: {
              video: {
                bitrate: videoInfos.bit_rate ?? '',
                colour_primaries: videoInfos.color_primaries ?? '',
                duration: Math.floor(videoInfos.duration * 1000) ?? '',
                format: videoInfos.codec_long_name.split('/')[1].trim() ?? '',
                frame_rate: videoInfos.r_frame_rate.split('/')[0] ?? '',
                height: videoInfos.height,
                matrix_coefficients: videoInfos.color_primaries ?? '',
                rotation: 0,
                transfer_characteristics: videoInfos.color_primaries ?? '',
                width: videoInfos.width,
              },
              audio: {
                bitrate: audioInfos.bit_rate,
                channels: audioInfos.channels,
                duration: Math.floor(audioInfos.duration * 1000) ?? '',
                format: audioInfos.codec_name.toUpperCase(),
                sampling_rate: audioInfos.sample_rate,
              },
            },
            timelines: [],
            cover: {
              fileid: uploadResult.uploadCoverId,
              file_id: uploadResult.uploadCoverId,
              height: uploadResult.coverDimensions.height,
              width: uploadResult.coverDimensions.width,
              frame: {
                ts: 0,
                is_user_select: false,
                is_upload: true,
              },
            },
            chapters: [],
            chapter_sync_text: false,
            segments: {
              count: 1,
              need_slice: false,
              items: [
                {
                  mute: 0,
                  speed: 1,
                  start: 0,
                  duration: videoInfos.duration,
                  transcoded: 0,
                  media_source: 1,
                  original_metadata: {
                    video: {
                      bitrate: videoInfos.bit_rate ?? '',
                      colour_primaries: videoInfos.color_primaries ?? '',
                      duration: Math.floor(videoInfos.duration * 1000) ?? '',
                      format:
                        videoInfos.codec_long_name.split('/')[1].trim() ?? '',
                      frame_rate: videoInfos.r_frame_rate.split('/')[0] ?? '',
                      height: videoInfos.height,
                      matrix_coefficients: videoInfos.color_primaries ?? '',
                      rotation: 0,
                      transfer_characteristics:
                        videoInfos.color_primaries ?? '',
                      width: videoInfos.width,
                    },
                    audio: {
                      bitrate: audioInfos.bit_rate,
                      channels: audioInfos.channels,
                      duration: Math.floor(audioInfos.duration * 1000) ?? '',
                      format: audioInfos.codec_name.toUpperCase(),
                      sampling_rate: audioInfos.sample_rate,
                    },
                  },
                },
              ],
            },
            entrance: 'web',
            backup_covers: [],
          };
        } else {
          const images = [];
          // 拼凑图文发布参数
          for (const imgInfo of uploadResult.imageList) {
            images.push({
              file_id: imgInfo.coverUploadFileId,
              width: imgInfo.coverDimensions.width,
              height: imgInfo.coverDimensions.height,
              metadata: {
                source: -1,
              },
              stickers: {
                version: 2,
                floating: [],
              },
              extra_info_json: JSON.stringify({
                mimeType:
                  'image/' + imgInfo.coverDimensions.type === 'jpg'
                    ? 'jpeg'
                    : imgInfo.coverDimensions.type,
              }),
            });
          }
          xhs_image_info = {
            images: images,
          };
        }
        // 处理标题、@好友、话题
        let description = platformSetting['desc'] ?? '';
        const hashTag = [];
        if (
          platformSetting.hasOwnProperty('topicsDetail') &&
          platformSetting.topicsDetail?.length > 0
        ) {
          for (const topicInfo of platformSetting.topicsDetail) {
            description += ` #${topicInfo.topicName}[话题]# `;
            hashTag.push({
              id: topicInfo.topicId,
              name: topicInfo.topicName,
              link: topicInfo.topicLink,
              type: 'topic',
            });
          }
        }
        const ats = [];
        if (
          platformSetting.hasOwnProperty('mentionedUserInfo') &&
          platformSetting.mentionedUserInfo?.length > 0
        ) {
          for (const userInfo of platformSetting.mentionedUserInfo) {
            if (
              userInfo.hasOwnProperty('nickName') &&
              userInfo.nickName !== '' &&
              userInfo.hasOwnProperty('uid') &&
              userInfo.uid !== ''
            ) {
              description += ` @${userInfo.nickName} `;
              ats.push({
                nickname: userInfo.nickName,
                user_id: userInfo.uid,
                name: userInfo.nickName,
              });
            }
          }
        }
        // 处理POI
        let post_loc = {};
        if (
          platformSetting.hasOwnProperty('poiInfo') &&
          typeof platformSetting.poiInfo === 'object' &&
          platformSetting.poiInfo.hasOwnProperty('poiId') &&
          platformSetting.poiInfo.poiId !== ''
        ) {
          post_loc = {
            poi_id: platformSetting.poiInfo.poiId,
            poi_type: platformSetting.poiInfo.poiType,
            subname: platformSetting.poiInfo.poiAddress,
            name: platformSetting.poiInfo.poiName,
          };
        }
        // 整合请求参数
        const requestData = {
          common: {
            type: publishType === 'video' ? 'video' : 'normal',
            title: platformSetting['title'],
            note_id: '',
            desc: description,
            source: JSON.stringify({
              type: 'web',
              ids: '',
              extraInfo: JSON.stringify({
                subType: '',
                systemId: 'web',
              }),
            }),
            business_binds: JSON.stringify({
              version: 1,
              noteId: 0,
              bizType:
                platformSetting.hasOwnProperty('timingTime') &&
                platformSetting.timingTime > Date.now()
                  ? 13
                  : 0,
              noteOrderBind: {},
              notePostTiming: {
                postTime:
                  platformSetting.hasOwnProperty('timingTime') &&
                  platformSetting.timingTime > Date.now()
                    ? platformSetting.timingTime.toString()
                    : '',
              },
              noteCollectionBind: {
                id: '',
              },
            }),
            ats: ats,
            hash_tag: hashTag,
            post_loc: post_loc,
            privacy_info: {
              op_type: 1,
              type: platformSetting['visibility_type'],
              user_ids:
                platformSetting['visibility_type'] !== 0 ? [] : undefined,
            },
          },
          image_info: xhs_image_info,
          video_info: xhs_video_info,
        };
        // 获取加密使用的Url
        const encryptUrl = this.postCreateVideoUrl.replace(
          'https://edith.xiaohongshu.com',
          '',
        );
        // 逆向获取XsXt
        const reverseRes: any = await this.getReverseResult({
          url: encryptUrl,
          data: requestData,
          a1: cookie_a1,
        });
        // 发起请求
        const createRes = await this.makeRequest(
          this.postCreateVideoUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json;charset=UTF-8',
              Cookie: cookieString,
              Referer: this.loginUrl,
              Origin: this.loginUrl,
              'X-S': reverseRes['X-s'],
              'X-T': reverseRes['X-t'],
            },
            data: requestData,
            timeout: 15000,
          },
          platformSetting.proxy,
        );

        // 处理结果
        if (createRes.hasOwnProperty('code') && createRes.code === -1) {
          reject('创建作品失败,失败原因:验签未通过');
          return;
        }
        if (createRes.hasOwnProperty('success') && !createRes.success) {
          reject('创建作品失败,失败原因:' + createRes.msg || '未知');
          return;
        }
        if (createRes.hasOwnProperty('result') && createRes.result !== 0) {
          reject('创建作品失败,失败原因:' + createRes.msg || '未知');
          return;
        }

        if (this.callback) this.callback(80, '发布完成，正在查询结果...');
        const worksList = await this.getWorks(cookieString);
        const works = worksList.data.data.notes.find(
          (v: any) => v.id === createRes.data.id,
        );
        // 返回结果
        resolve({
          shareLink: `https://www.xiaohongshu.com/explore/${createRes.data.id}?xsec_token=${works!.xsec_token}&xsec_source=${works!.xsec_source}`,
          publishId: createRes.data.id,
        });
      } catch (err: any) {
        let errorMessage;
        if (err && err.message) {
          errorMessage = err.message;
        } else if (err) {
          errorMessage = err;
        } else {
          errorMessage = '未知';
        }
        reject('创建作品失败,失败原因:' + errorMessage);
      }
    });
  }

  /**
   * 视频作品发布
   * @param cookies
   * @param filePath
   * @param platformSetting
   * @param callback
   */
  async publishVideoWorkApi(
    cookies: string,
    filePath: string,
    platformSetting: XSLPlatformSettingType,
    callback: (progress: number, msg?: string) => void,
  ): Promise<{
    publishTime: number;
    publishId: string;
    shareLink: string;
  }> {
    console.log('小红书视频发布初始发布参数：', {
      filePath,
      platformSetting,
    });
    return new Promise(async (resolve, reject) => {
      try {
        // 首选官方创作页引擎发布（官方 SDK 自动签名，绕开自拼签名 406 风险）；
        // 失败回退到下方自拼签名 API 流程
        if (filePath) {
          try {
            const creatorResult = await publishVideoNoteViaCreator({
              videoPath: filePath,
              title: platformSetting.title ?? '',
              desc: platformSetting.desc ?? '',
              topics: (platformSetting.topicsDetail || [])
                .map((t) => t.topicName || t.topicId)
                .filter((t): t is string => !!t),
            });
            console.log('小红书视频发布（官方引擎）成功：', creatorResult);
            resolve({
              publishTime: Math.floor(Date.now() / 1000),
              publishId: creatorResult.noteId,
              shareLink: creatorResult.shareLink,
            });
            return;
          } catch (creatorError) {
            console.warn(
              '小红书官方创作页视频发布失败，回退 API 发布:',
              creatorError,
            );
          }
        }
        this.callback = callback;
        callback(5, '正在加载...');
        // 获取文件信息
        const fileInfo = await FileUtils.getFileInfo(filePath);
        // 初始化cookie
        callback(10);
        const cookieString = CommonUtils.convertCookieToJson(cookies);
        // 获取文件大小及分片信息
        callback(15);
        const filePartInfo = await FileUtils.getFilePartInfo(
          filePath,
          this.fileBlockSize,
        );

        callback(20, '正在上传视频...');
        // 上传视频,获取远程Url
        const { uploadFileId } = await this.uploadVideoFile(
          cookieString,
          filePath,
          filePartInfo,
          fileInfo,
          platformSetting.proxy,
        );

        callback(60, '正在上传封面...');
        // 上传封面,获取远程Url
        const { coverDimensions, coverUploadFileId } =
          await this.uploadCoverFile(
            cookieString,
            platformSetting['cover'],
            platformSetting.proxy,
          );
        const cookieObject = JSON.parse(cookies);
        let cookie_a1 = null;
        for (const cookieItem of cookieObject) {
          if (cookieItem.name === 'a1') {
            cookie_a1 = cookieItem.value;
            break;
          }
        }

        // 创建作品
        const uploadResult = {
          uploadFileId: uploadFileId,
          uploadCoverId: coverUploadFileId,
          coverDimensions: coverDimensions,
          fileInfo: fileInfo,
        };
        callback(70, '正在发布...');

        console.log('小红书视频发布最终发布参数：', {
          platformSetting,
          uploadResult,
        });
        console.log('topicsDetail:', platformSetting.topicsDetail);
        const result: any = await this.postCreateVideo(
          cookieString,
          cookie_a1,
          'video',
          uploadResult,
          platformSetting,
          platformSetting.proxy,
        ).catch((err) => {
          reject(err);
        });
        console.log(result);
        // 返回信息
        resolve({
          publishTime: Math.floor(Date.now() / 1000),
          publishId: result.publishId,
          shareLink: result.shareLink,
        });
      } catch (err) {
        console.warn(err);
        reject(err);
        callback(-1);
      }
    });
  }

  /**
   * 获取X-Sign请求参数
   * @param requestUrl
   */
  getRequestXSign(requestUrl: any) {
    return new Promise((resolve, reject) => {
      try {
        const replaceUrl =
          requestUrl.replace('https://www.xiaohongshu.com', '') + 'WSUDD';
        const xSign =
          'X' + crypto.createHash('md5').update(replaceUrl).digest('hex');
        resolve(xSign);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 获取小红书Xs|Xt
   */
  async getReverseResult(args: any): Promise<any> {
    // 首选页面内签名器（window._webmsxyw，随小红书页面自动维护）；
    // 外部签名服务器 116.62.154.231:7879 已失效（HTTP 404），仅作兜底。
    // 签名与 User-Agent、a1 cookie 双绑定：必须与请求侧完全一致，否则平台返回 406。
    const a1Match = /(?:^|;\\s*)a1=([^;]+)/.exec(String(args.a1 ?? ''));
    const a1 = a1Match ? decodeURIComponent(a1Match[1]) : undefined;
    const inPage = await signInPage(args.url, args.data, this.defaultUserAgent, a1);
    if (inPage) {
      return inPage;
    }
    logger.warn('[xhs-sign] 页面内签名不可用，回退外部签名服务器');
    return await this.makeRequest(
      'http://116.62.154.231:7879',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
        },
        data: args,
        timeout: 15000,
      },
      '',
    );
  }

  // 获取话题数据
  async getTopics({
    keyword,
    cookies,
  }: {
    keyword: string;
    cookies: Electron.Cookie[];
  }) {
    return await requestNet<IXHSTopicsResponse>({
      url: `https://edith.xiaohongshu.com/web_api/sns/v1/search/topic`,
      method: 'POST',
      headers: {
        cookie: CookieToString(cookies),
        Referer: this.loginUrl,
        origin: this.loginUrl,
      },
      body: {
        keyword: keyword,
        page: {
          page_size: 30,
          page: 1,
        },
      },
    });
  }

  // 获取位置数据
  async getLocations(params: {
    latitude: number;
    longitude: number;
    keyword: string;
    page?: number;
    size?: number;
    source?: string;
    type?: number;
    cookies: Electron.Cookie[];
  }) {
    return await requestNet<IXHSLocationResponse>({
      url: 'https://edith.xiaohongshu.com/web_api/sns/v1/local/poi/creator/search',
      headers: {
        cookie: CookieToString(params.cookies),
        Referer: this.loginUrl,
        origin: this.loginUrl,
      },
      method: 'POST',
      body: {
        ...params,
        page: 1,
        size: 50,
        source: 'WEB',
        type: 3,
      },
    });
  }

  // 获取作品列表
  async getSearchNodeList(cookie: string, qe: string, page: number = 0) {
    const url = `/api/sns/web/v1/search/notes`;

    // 生成搜索ID的函数
    function base36encode(number: number): string {
      const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
      let base36 = '';
      while (number > 0) {
        const remainder = number % 36;
        base36 = digits[remainder] + base36;
        number = Math.floor(number / 36);
      }
      return base36;
    }

    function generateSearchId(): string {
      const timestamp = BigInt(Date.now() * 1000) << BigInt(64);
      const randomValue = BigInt(Math.floor(Math.random() * 2147483646));
      return base36encode(Number(timestamp + randomValue));
    }

    const body = {
      keyword: qe,
      page: page,
      page_size: 20,
      search_id: generateSearchId(),
      sort: 'general',
      note_type: 0,
      ext_flags: [],
      geo: '',
      filters: [
        { tags: ['general'], type: 'sort_type' },
        { tags: ['不限'], type: 'filter_note_type' },
        { tags: ['不限'], type: 'filter_note_time' },
        { tags: ['不限'], type: 'filter_note_range' },
        { tags: ['不限'], type: 'filter_pos_distance' },
      ],
      image_formats: ['jpg', 'webp', 'avif'],
    };

    const reverseRes: any = await this.getReverseResult({
      url,
      a1: cookie,
      data: body,
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Referer: this.loginUrl,
          Origin: this.loginUrl,
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
        data: body,
      },
      '',
    );

    return res;
  }

  // 获取作品列表
  async getWorks(cookie: string, page: number = 0) {
    const url = `/web_api/sns/v5/creator/note/user/posted?tab=0&page=${page}`;
    const reverseRes: any = await this.getReverseResult({
      url,
      a1: cookie,
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'GET',
        headers: {
          Cookie: cookie,
          Referer: this.loginUrl,
          Origin: this.loginUrl,
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
      },
      '',
    );

    return res;
  }

  // 获取@用户列表
  async getUsers(cookie: Electron.Cookie[], keyword: string, page: number) {
    return await requestNet<XiaohongshuApiResponse>({
      url: `https://edith.xiaohongshu.com/web_api/sns/v1/search/user_info`,
      headers: {
        cookie: CookieToString(cookie),
        Referer: this.loginUrl,
        origin: this.loginUrl,
      },
      method: 'POST',
      body: {
        keyword,
        search_id: '',
        page: {
          page_size: 10,
          page,
        },
      },
    });
  }

  /**
   * 获取评论列表
   * @param cookie
   * @param noteId
   * @param cursor
   * @returns
   */
  async getCommentList(
    cookie: Electron.Cookie[],
    note: {
      id: string;
      xsec_token: string;
    },
    cursor?: number,
  ) {
    logger.log('小红书 ------ getCommentList ---- start');

    const url = `/api/sns/web/v2/comment/page?note_id=${note.id}&cursor=${cursor || ''}&top_comment_id=&image_formats=jpg,webp,avif&xsec_token=${note.xsec_token}`;
    const reverseRes: any = await this.getReverseResult({
      url,
      a1: CookieToString(cookie),
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'GET',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: this.loginUrlHome,
          origin: this.loginUrlHome,
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
      },
      '',
    );

    logger.log('小红书 ------ getCommentList ---- end', res);

    return res;
  }

  // 获取二级评论列表
  async getSecondCommentList(
    cookie: Electron.Cookie[],
    noteId: string,
    root_comment_id: string,
    cursor?: string,
  ) {
    const url = `/api/sns/web/v2/comment/sub/page?note_id=${noteId}&root_comment_id=${root_comment_id}&num=10&cursor=${cursor || ''}&top_comment_id=&image_formats=jpg,webp,avif&xsec_token=${esec_token}`;
    const reverseRes: any = await this.getReverseResult({
      url,
      a1: CookieToString(cookie),
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'GET',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: this.loginUrlHome,
          origin: this.loginUrlHome,
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
      },
      '',
    );

    return res;
  }

  /**
   * 点赞作品
   * @param cookie
   * @param noteId
   * @param content
   * @param targetCommentId // 回复的评论ID
   * @returns
   */
  async likeNote(cookie: Electron.Cookie[], noteId: string) {
    const url = `/api/sns/web/v1/note/like`;
    const body = {
      note_oid: noteId,
    };
    const reverseRes: any = await this.getReverseResult({
      url,
      a1: CookieToString(cookie),
      data: body,
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'POST',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: 'https://www.xiaohongshu.com/',
          Origin: 'https://www.xiaohongshu.com',
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
        data: body,
      },
      '',
    );

    return res;
  }

  /**
   * 收藏作品
   * @param cookie
   * @param noteId
   * @param content
   * @param targetCommentId // 回复的评论ID
   * @returns
   */
  async shoucangNote(cookie: Electron.Cookie[], noteId: string) {
    const url = `/api/sns/web/v1/note/collect`;
    const body = {
      note_id: noteId,
    };
    const reverseRes: any = await this.getReverseResult({
      url,
      a1: CookieToString(cookie),
      data: body,
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'POST',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: 'https://www.xiaohongshu.com/',
          Origin: 'https://www.xiaohongshu.com',
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
        data: body,
      },
      '',
    );

    return res;
  }

  /**
   * 评论作品
   * @param cookie
   * @param noteId
   * @param content
   * @param targetCommentId // 回复的评论ID
   * @returns
   */
  async commentPost(
    cookie: Electron.Cookie[],
    noteId: string,
    content: string,
    targetCommentId?: string,
  ) {
    const url = `/api/sns/web/v1/comment/post`;
    const body = {
      note_id: noteId,
      content,
      target_comment_id: targetCommentId || undefined,
      at_users: [],
    };
    const reverseRes: any = await this.getReverseResult({
      url,
      a1: CookieToString(cookie),
      data: body,
    });

    const res = await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'POST',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: 'https://www.xiaohongshu.com/',
          Origin: 'https://www.xiaohongshu.com',
          'X-S': reverseRes['X-s'],
          'X-T': reverseRes['X-t'],
        },
        data: body,
      },
      '',
    );
    return res;
  }

  // ===== 私信（IM）通道 ===== //
  // 使用小红书网页版当前生效的 IM 端点（edith.xiaohongshu.com /api/im/web/*，
  // 已实测 200 且无需 X-S/X-T 签名；旧的 /api/sns/web/v1/im/* jarvis 端点已废弃）。

  /**
   * 获取私信会话列表（v3 会话列表，含陌生人消息会话）
   */
  async getImConversations(cookie: Electron.Cookie[]) {
    const url = '/api/im/web/v3/chats?limit=100&complete=true&page=0&source=pc';
    return await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'GET',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: this.loginUrlHome,
          Origin: this.loginUrlHome,
        },
      },
      '',
    );
  }

  /**
   * 获取会话消息列表
   * @param lastId 会话 max_store_id（历史游标，传 0 表示最新）
   */
  async getImMessages(
    cookie: Electron.Cookie[],
    sessionId: string,
    lastId?: number,
  ) {
    const url =
      '/api/im/web/messages/history?chat_user_id=' +
      sessionId +
      '&last_id=' + (lastId ?? 0) +
      '&start_id=0&limit=30';
    return await this.makeRequest(
      'https://edith.xiaohongshu.com' + url,
      {
        method: 'GET',
        headers: {
          Cookie: CookieToString(cookie),
          Referer: this.loginUrlHome,
          Origin: this.loginUrlHome,
        },
      },
      '',
    );
  }

  /**
   * 发送私信文本消息：改走官方聊天页（www.xiaohongshu.com/chat/<peer>）引擎，
   * 由小红书官方前端完成签名与协议封装，规避已废弃的 REST 发送端点。
   */
  async sendImMessage(
    _cookie: Electron.Cookie[],
    sessionId: string,
    content: string,
  ) {
    const { sendXhsChatMessage } = await import(
      '../../main/plat/xhsImSender'
    );
    return await sendXhsChatMessage(sessionId, content);
  }
}

// 导出服务实例
export const xiaohongshuService = new XiaohongshuService();
