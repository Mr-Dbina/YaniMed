import { Module } from '@nestjs/common';
import { MockTestController } from './mock-test.controller.js';
import { MockTestGuard } from './mock-test.guard.js';

@Module({
  controllers: [MockTestController],
  providers: [MockTestGuard],
})
export class MockTestModule {}
