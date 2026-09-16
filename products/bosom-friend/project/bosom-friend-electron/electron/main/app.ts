/*
 * @Author: nevin
 * @Date: 2025-01-24 16:33:22
 * @LastEditTime: 2025-03-18 20:53:15
 * @LastEditors: nevin
 * @Description:
 */
import { Module } from './core/decorators';
import { AccountModule } from './account/module';
import { initSqlite3Db } from '../db';
import { PublishModule } from './publish/module';
import { UserModule } from './user/module';
import { ToolsModule } from './tools/module';
import { AppController } from './controller';
import { AppService } from './service';
import { BackupModule } from './backup/module';
import { ReplyModule } from './reply/module';
import { KnowledgeModule } from './knowledge/module';
import { AutoRunModule } from './autoRun/module';
import { InteractionModule } from './interaction/module';
import { DmModule } from './dm/module';
import { SafetyModule } from './safety/module';
import { BrowserControlModule } from './browserControl/module';

@Module({
  imports: [
    ToolsModule,
    UserModule,
    AccountModule,
    PublishModule,
    BackupModule,
    ReplyModule,
    KnowledgeModule,
    AutoRunModule,
    InteractionModule,
    DmModule,
    SafetyModule,
    BrowserControlModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class App {
  constructor() {
    this._init();
  }

  async _init() {
    // 初始化数据库
    await initSqlite3Db();
  }
}

export default App;
