import {
  CanActivate, ExecutionContext, ForbiddenException, HttpException,
  Injectable, NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';

/** Requests per fixed one-minute window. The exam autosaves one answer per
 * question, so the Mock Test quota is more generous than chat. */
export const MOCK_TEST_REQUESTS_PER_MINUTE = 60;

/** Localhost-only, feature-flagged protection with its own quota counter. */
@Injectable()
export class MockTestGuard implements CanActivate {
  private windowStart = 0;
  private count = 0;

  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
    if (process.env.MOCK_TEST_ENABLED !== 'true') throw new NotFoundException();
    const req = context.switchToHttp().getRequest<Request>();
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) ||
        !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
        req.headers.forwarded || req.headers['x-forwarded-for']) {
      throw new ForbiddenException('Mock Test endpoints are local-only.');
    }
    const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
      .split(',').map((origin) => origin.trim());
    if ((req.headers.origin && !origins.includes(req.headers.origin)) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ForbiddenException('Origin is not allowed.');
    }
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (++this.count > MOCK_TEST_REQUESTS_PER_MINUTE) {
      throw new HttpException('Mock Test request limit exceeded. Retry in one minute.', 429);
    }
    return true;
  }

  /** Test-only hook: start a fresh fixed window on this instance. */
  resetRateLimit(): void {
    this.windowStart = 0;
    this.count = 0;
  }
}
