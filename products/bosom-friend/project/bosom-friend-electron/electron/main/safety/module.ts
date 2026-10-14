/*
 * 平台安全防护模块
 */
import { Module } from '../core/decorators';
import { SafetyController } from './controller';

@Module({
  controllers: [SafetyController],
  providers: [],
})
export class SafetyModule {}
