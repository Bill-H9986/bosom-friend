/*
 * @Author: nevin
 * @Date: 2025-01-20 22:02:54
 * @LastEditTime: 2025-03-28 13:33:08
 * @LastEditors: nevin
 * @Description: autoRun AutoRun
 */
import { Controller, Icp, Inject, Scheduled } from '../core/decorators';
import { AutoRunService } from './service';
import { AutoRunStatus, AutoRunType } from '../../db/models/autoRun';
import { getUserInfo } from '../user/comment';
import { EtEvent } from '../../global/event';
import { autoRunTypeEtTag } from './comment';
import { AutoRunRecordStatus } from '../../db/models/autoRunRecord';

@Controller()
export class AutoRunController {
  @Inject(AutoRunService)
  private readonly autoRunService!: AutoRunService;

  /**
   * 创建进程
   */
  @Icp('ICP_AUTO_RUN_CREATE')
  async createAutoRun(
    event: Electron.IpcMainInvokeEvent,
    info: {
      accountId: number;
      type: AutoRunType;
      cycleType: string;
    },
    data: Record<string, any>, // 对象
  ) {
    const userInfo = getUserInfo();

    const autoRun = await this.autoRunService.createAutoRun(
      {
        userId: userInfo.id,
        ...info,
      },
      data,
    );

    return autoRun;
  }

  /**
   * 进程列表
   */
  @Icp('ICP_AUTO_RUN_LIST')
  async getAutoRunList(
    event: Electron.IpcMainInvokeEvent,
    pageInfo: {
      page: number;
      pageSize: number;
    },
    query: {
      type?: AutoRunType;
      status?: AutoRunStatus;
      cycleType?: string;
      accountId?: number;
      dataId?: string;
    },
  ) {
    const list = await this.autoRunService.findAutoRunList(pageInfo, query);
    return list;
  }

  /**
   * 更新进程状态
   */
  @Icp('ICP_AUTO_RUN_STATUS')
  async updateAutoRunStatus(
    event: Electron.IpcMainInvokeEvent,
    id: number,
    status: AutoRunStatus,
  ) {
    const autoRun = await this.autoRunService.updateAutoRunStatus(id, status);

    return autoRun;
  }

  /**
   * 创建进程记录
   */
  @Icp('ICP_AUTO_RUN_RECORD_CREATE')
  async createAutoRunRecord(
    event: Electron.IpcMainInvokeEvent,
    autoRunId: number,
  ) {
    const autoData = await this.autoRunService.findAutoRunById(autoRunId);
    if (!autoData) return null;
    const autoRunRecord =
      await this.autoRunService.createAutoRunRecord(autoData);

    return autoRunRecord;
  }

  /**
   * 更新进程记录状态
   */
  @Icp('ICP_AUTO_RUN_RECORD_STATUS')
  async updateAutoRunRecordStatus(
    event: Electron.IpcMainInvokeEvent,
    id: number,
    status: number,
  ) {
    const autoRun = await this.autoRunService.updateAutoRunRecordStatus(
      id,
      status,
    );

    return autoRun;
  }

  /**
   * 获取进程记录列表
   */
  @Icp('ICP_AUTO_RUN_RECORD_LIST')
  async getCommentList(
    event: Electron.IpcMainInvokeEvent,
    pageInfo: {
      page: number;
      pageSize: number;
    },
    query: {
      autoRunId: number;
      type?: AutoRunType;
      status?: AutoRunRecordStatus;
      cycleType?: string;
    },
  ): Promise<any> {
    const list = await this.autoRunService.findAutoRunRecordList(
      pageInfo,
      query,
    );

    return list;
  }

  // 立即执行进程
  @Icp('ICP_RUN_NOW_AUTO_RUN')
  async autoRunStart(event: Electron.IpcMainInvokeEvent, id: number) {
    const item = await this.autoRunService.findAutoRunById(id);
    if (!item) return false;

    const tag = autoRunTypeEtTag.get(item.type);
    if (!tag) return false;

    EtEvent.emit(tag, item);

    console.log('---- autoRunStart ----');
    return true;
  }

  // 每1分钟轮询一次需要启动的自动化任务。
  // ⚠ 并发改造说明：原实现在 autoRunList.map(async ...) 中 fire-and-forget，
  // 多个养号器/创作者窗口会同时初始化（auto-douyin-window、xhs-warmup 等
  // 每个都会拉一个隐藏 BrowserWindow），瞬时压垮 GPU 进程并叠加大量 Redis
  // 连接，曾导致 10:16:46 的 ioredis ECONNRESET/ECONNREFUSED 雪崩 → app 假死。
  // 现在改为串行：逐个 emit，单个任务抛错隔离成一个 try/catch，不影响后续任务。
  @Scheduled('*/1 * * * *', 'all_auto_run_start')
  async syncAllAutoRunStart() {
    console.log('---- syncAllAutoRunStart ----');
    try {
      const userInfo = getUserInfo();

      const autoRunList = await this.autoRunService.findAutoRunListOfNeedRun(
        userInfo.id,
      );

      for (const item of autoRunList) {
        try {
          const tag = autoRunTypeEtTag.get(item.type);
          if (!tag) continue;

          const needRun = await this.autoRunService.isNeedAutoRunToRun(item);
          if (!needRun) continue;

          EtEvent.emit(tag, item);
        } catch (error) {
          console.error('---- syncAllAutoRunStart ---- item error', item?.id, error);
        }
      }
    } catch (error) {
      console.error('---- syncAllAutoRunStart ---- error', error);
    }
  }
}
