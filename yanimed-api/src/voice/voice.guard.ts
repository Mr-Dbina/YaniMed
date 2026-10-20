import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';

/** Single-process, local-beta protection. Forwarded addresses are never trusted. */
@Injectable()
export class VoiceGuard implements CanActivate {
  private windowStart = 0;
  private count = 0;

  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
    const req = context.switchToHttp().getRequest<Request>();
    const remote = req.socket.remoteAddress;
    const host = req.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))
      throw new ForbiddenException('Voice endpoints require a local host.');
    if (
      !remote ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) ||
      req.headers.forwarded ||
      req.headers['x-forwarded-for']
    ) {
      throw new ForbiddenException('Voice endpoints are local-only.');
    }
    const allowed = (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
      .split(',')
      .map((s) => s.trim());
    if (req.headers.origin && !allowed.includes(req.headers.origin))
      throw new ForbiddenException('Origin is not allowed.');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new ForbiddenException(
        'Cross-site voice requests are not allowed.',
      );
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (++this.count > 10)
      throw new HttpException(
        'Voice request limit exceeded. Retry in one minute.',
        429,
      );
    return true;
  }
}
