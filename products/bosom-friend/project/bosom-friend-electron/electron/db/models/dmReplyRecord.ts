/*
 * 私信自动回复记录
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TempModel } from './temp';
import { PlatType } from '../../../commont/AccountEnum';

@Entity({ name: 'dmReplyRecord' })
export class DmReplyRecordModel extends TempModel {
  @PrimaryGeneratedColumn({ type: 'int', comment: 'id' })
  id!: number;

  @Column({ type: 'varchar', nullable: false, comment: '用户id' })
  userId!: string;

  @Column({ type: 'int', nullable: false, comment: '账号id,对应account表id' })
  accountId!: number;

  @Column({
    type: 'varchar',
    enum: PlatType,
    nullable: true,
    comment: '平台类型',
  })
  type!: PlatType;

  @Column({ type: 'varchar', nullable: false, comment: '会话ID' })
  conversationId!: string;

  @Column({ type: 'varchar', nullable: false, comment: '会话短ID' })
  conversationShortId!: string;

  @Column({ type: 'varchar', nullable: false, comment: '已处理消息ID' })
  serverMessageId!: string;

  @Column({ type: 'varchar', nullable: true, comment: '访客用户ID' })
  senderUid?: string;

  @Column({ type: 'varchar', nullable: true, comment: '访客昵称' })
  senderName?: string;

  @Column({ type: 'varchar', nullable: false, comment: '访客消息' })
  message!: string;

  @Column({ type: 'varchar', nullable: false, comment: 'AI回复内容' })
  reply!: string;

  @Column({ type: 'int', nullable: false, default: 1, comment: '状态：1成功 0失败' })
  status!: number;
}
