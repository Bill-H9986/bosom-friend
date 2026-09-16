/*
 * 私信自动接待 IPC
 */
import { Controller, Icp, Inject } from '../core/decorators';
import { DmReceptionService } from './service';
import { ReplyService } from '../reply/service';

@Controller()
export class DmController {
  @Inject(DmReceptionService)
  private readonly dmReceptionService!: DmReceptionService;

  @Inject(ReplyService)
  private readonly replyService!: ReplyService;

  /** 获取私信接待状态 */
  @Icp('ICP_DM_GET_STATUS')
  async getStatus() {
    return this.dmReceptionService.getStatus();
  }

  /** 全局监控总览：评论接待 + 私信接待（全局监控页实时展示） */
  @Icp('ICP_GLOBAL_MONITOR_STATUS')
  async globalMonitorStatus() {
    return {
      comment: this.replyService.getMonitorStatus(),
      dm: this.dmReceptionService.getStatus(),
    };
  }

  /** 私信自动接待（常驻开启，7x24 全自动，无需开关） */
  @Icp('ICP_DM_SET_ENABLED')
  async setEnabled(_event: Electron.IpcMainInvokeEvent, enabled: boolean) {
    return this.dmReceptionService.setEnabled(!!enabled);
  }

  /** 立即轮询一次 */
  @Icp('ICP_DM_POLL_NOW')
  async pollNow() {
    return this.dmReceptionService.pollAll();
  }

  /** 获取私信回复记录 */
  @Icp('ICP_DM_GET_RECORDS')
  async getRecords(_event: Electron.IpcMainInvokeEvent, limit?: number) {
    return this.dmReceptionService.getRecords(limit || 50);
  }

  /** 拉取账号会话列表（界面预览） */
  @Icp('ICP_DM_LIST_CONVERSATIONS')
  async listConversations(_event: Electron.IpcMainInvokeEvent, accountId: number) {
    return this.dmReceptionService.listConversations(accountId);
  }
}
