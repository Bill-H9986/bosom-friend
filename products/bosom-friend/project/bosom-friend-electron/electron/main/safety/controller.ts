/*
 * 平台安全防护 IPC：查看账号风控状态 / 手动解除
 */
import { Controller, Icp } from '../core/decorators';
import { riskManager } from './riskManager';
import { quotaManager } from './quotaManager';

@Controller()
export class SafetyController {
  /** 获取所有账号的风控状态 */
  @Icp('ICP_SAFETY_GET_RISK_STATUS')
  async getRiskStatus(
    _event: Electron.IpcMainInvokeEvent,
    accounts: { id: number; type: string; nickname?: string }[],
  ) {
    return (accounts || []).map((a) => ({
      accountId: a.id,
      platform: a.type,
      nickname: a.nickname || '',
      ...riskManager.getStatus(a.type, a.id),
      quota: quotaManager.getTodayUsage(a.type, a.id),
    }));
  }

  /** 手动解除账号风控（用户确认账号恢复正常后） */
  @Icp('ICP_SAFETY_CLEAR_RISK')
  async clearRisk(
    _event: Electron.IpcMainInvokeEvent,
    platform: string,
    accountId: number,
  ) {
    riskManager.clearRisk(platform, accountId);
    return { ok: true };
  }
}
