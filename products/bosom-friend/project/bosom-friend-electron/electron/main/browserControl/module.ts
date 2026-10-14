/**
 * 浏览器控制模块 —— Chrome / Edge 双浏览器自动化支撑
 */
import { Module } from '../core/decorators';
import { BrowserControlController } from './controller';

@Module({
  controllers: [BrowserControlController],
  providers: [],
})
export class BrowserControlModule {}
