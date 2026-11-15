import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../../src/app.module.js';
import { GenerationAiService } from '../../../src/mock-test/generation/ai/generation-ai.service.js';

/**
 * Boots the real AppModule on an ephemeral port, with only the AI replaced.
 * Every other provider, the HTTP stack, the worker and the reconciler are the
 * production ones.
 */
export interface RunningE2eApp {
  app: INestApplication;
  url: string;
  close(): Promise<void>;
}

export async function startE2eApp(fake: unknown): Promise<RunningE2eApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GenerationAiService)
    .useValue(fake)
    .compile();

  const app = moduleRef.createNestApplication();
  // Silent by default; set M5_E2E_LOGS=1 to see worker error/warn lines.
  app.useLogger(process.env.M5_E2E_LOGS === '1' ? ['error', 'warn'] : false);
  const server = (await app.listen(0, '127.0.0.1')) as unknown as {
    address(): AddressInfo | string | null;
  };
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await app.close();
    throw new Error('The test app did not bind a TCP port.');
  }

  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await app.close();
    },
  };
}
