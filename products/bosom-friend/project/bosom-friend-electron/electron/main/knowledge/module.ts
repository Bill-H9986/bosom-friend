/**
 * KnowledgeModule - 知识库模块
 */
import { Module } from '../core/decorators';
import { KnowledgeController } from './controller';
import { KnowledgeService } from './service';

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
})
export class KnowledgeModule {}
