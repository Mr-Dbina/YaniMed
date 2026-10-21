import {
  Injectable,
  InternalServerErrorException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { omnirouteEnv, requireEnv } from '../config/env.validation.js';

/** Per-request ceiling. Answers here are single-shot, not streamed. */
const REQUEST_TIMEOUT_MS = 60_000;

interface OmniRouteCompletion {
  content: string;
  /** Model the gateway actually served. May differ from the combo name. */
  model: string | null;
}

export interface HealthReport {
  reachable: boolean;
  baseUrl: string;
  model: string;
  modelCount: number | null;
  error: string | null;
}

@Injectable()
export class OmniRouteService implements OnModuleInit {
  private readonly logger = new Logger(OmniRouteService.name);

  private baseUrl = '';
  private apiKey = '';
  private primaryModel = '';

  constructor(private readonly config: ConfigService) {}

  getRequestedModel(): string {
    return this.primaryModel;
  }

  onModuleInit(): void {
    // Fail fast and loudly if the gateway is unconfigured, rather than
    // surfacing a confusing 500 on the first request.
    requireEnv(omnirouteEnv, 'OmniRoute');
    this.baseUrl = this.normaliseBaseUrl(this.config.get<string>('omnirouteBaseUrl')!);
    this.apiKey = this.config.get<string>('omnirouteApiKey')!;
    this.primaryModel = this.config.get<string>('omniroutePrimaryModel')!;
  }

  /**
   * OMNIROUTE_BASE_URL is documented both as the gateway root and as the
   * OpenAI-compatible root with /v1 appended. Accept either so the variable
   * does not have to be edited when one convention is chosen.
   */
  private normaliseBaseUrl(raw: string): string {
    return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/v1${path}`;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    // HeadersInit may be an array, so it is normalised through Headers rather
    // than spread into an object literal.
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${this.apiKey}`);

    return fetch(this.endpoint(path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * Upstream failures are summarised, never forwarded. A raw gateway body can
   * contain provider detail or quota state that has no business reaching a
   * client, so only our own message is surfaced.
   */
  private async upstreamError(res: Response, action: string): Promise<Error> {
    const status = res.status;
    this.logger.warn(`${action} failed: OmniRoute responded ${status}`);
    if (status === 401 || status === 403) {
      return new ServiceUnavailableException(
        'OmniRoute rejected the API key. Check OMNIROUTE_API_KEY.',
      );
    }
    if (status === 429) {
      return new ServiceUnavailableException(
        'OmniRoute is rate limited. Retry shortly.',
      );
    }
    return new InternalServerErrorException(
      `OmniRoute request failed with status ${status}.`,
    );
  }

  async checkHealth(): Promise<HealthReport> {
    const report: HealthReport = {
      reachable: false,
      baseUrl: this.baseUrl,
      model: this.primaryModel,
      modelCount: null,
      error: null,
    };

    try {
      const res = await this.request('/models', { method: 'GET' });
      if (!res.ok) {
        report.error = `HTTP ${res.status}`;
        return report;
      }
      const body = (await res.json()) as { data?: unknown[] };
      report.reachable = true;
      report.modelCount = Array.isArray(body.data) ? body.data.length : null;
    } catch (err) {
      report.error = err instanceof Error ? err.message : 'unknown error';
    }

    return report;
  }

  /**
   * Single-shot completion through the configured model. Provider fallback is
   * intentionally NOT implemented here - the Combo owns that chain.
   */
  async complete(prompt: string, systemPrompt?: string): Promise<OmniRouteCompletion> {
    const messages: { role: 'system' | 'user'; content: string }[] = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    let res: Response;
    try {
      res = await this.request('/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: this.primaryModel,
          messages,
          temperature: 0,
          stream: false,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.logger.warn(`chat/completions unreachable: ${message}`);
      throw new ServiceUnavailableException(
        'Could not reach OmniRoute. Is it running on the configured base URL?',
      );
    }

    if (!res.ok) throw await this.upstreamError(res, 'chat/completions');

    const body = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
    };
    const content = body.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || content.length === 0) {
      this.logger.warn('chat/completions returned no message content');
      throw new InternalServerErrorException(
        'OmniRoute returned an empty completion.',
      );
    }

    return { content, model: body.model ?? null };
  }
}
