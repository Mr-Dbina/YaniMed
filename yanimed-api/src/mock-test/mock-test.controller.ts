import { Controller, Get, UseGuards } from '@nestjs/common';
import { MockTestGuard } from './mock-test.guard.js';

@UseGuards(MockTestGuard)
@Controller('mock-test')
export class MockTestController {
  @Get('health')
  health() {
    return { ok: true, module: 'mock-test', questionsPerTest: 25 };
  }
}
