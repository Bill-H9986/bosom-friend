/*
 * 数据统计类型（自 src/views/statistics/comment.ts 迁移）
 */

import { AccountInfo } from '@/views/account/comment';
import { DashboardData as DashboardDataLast } from '../../electron/main/plat/plat.type';

export interface StatisticsInfo {
  accountTotal: number;
  list: AccountInfo[];
  fansCount: number;
  readCount: number;
  likeCount: number;
  collectCount: number;
  commentCount: number;
  income: number;
}

/** 获取平台账号统计信息返回值 */
export type DashboardData = DashboardDataLast;
