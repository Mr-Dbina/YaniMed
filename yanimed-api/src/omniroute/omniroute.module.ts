import { Module } from '@nestjs/common';
import { OmniRouteController } from './omniroute.controller.js';
import { OmniRouteService } from './omniroute.service.js';

@Module({
  controllers: [OmniRouteController],
  providers: [OmniRouteService],
  exports: [OmniRouteService],
})
export class OmniRouteModule {}