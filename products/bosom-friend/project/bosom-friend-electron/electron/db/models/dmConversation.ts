/*
 * 已发现的私信会话（用于持续轮询，覆盖已回复过的会话再次来新消息的情况）
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TempModel } from './temp';

@Entity({ name: 'dmConversation' })
export class DmConversationModel extends TempModel {
  @PrimaryGeneratedColumn({ type: 'int', comment: 'id' })
  id!: number;

  @Column({ type: 'int', nullable: false, comment: '账号id' })
  accountId!: number;

  @Column({ type: 'varchar', nullable: false, comment: '会话ID' })
  conversationId!: string;

  @Column({ type: 'varchar', nullable: false, comment: '会话短ID' })
  conversationShortId!: string;

  @Column({ type: 'varchar', nullable: true, comment: '访客用户ID' })
  peerUid?: string;

  @Column({ type: 'varchar', nullable: true, comment: '访客昵称' })
  peerName?: string;

  @Column({ type: 'varchar', nullable: true, comment: '访客secUid' })
  peerSecUid?: string;
}
