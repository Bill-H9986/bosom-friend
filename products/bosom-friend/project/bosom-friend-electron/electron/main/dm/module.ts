/*
 * 私信自动接待模块
 */
import { AccountModule } from '../account/module';
import { Module } from '../core/decorators';
import { DmController } from './controller';
import { DmReceptionService } from './service';

@Module({
  imports: [AccountModule],
  controllers: [DmController],
  providers: [DmReceptionService],
})
export class DmModule {}
