import { validateEnv } from '../src/config/env.validation.js';

try {
  validateEnv();
  console.log('BOOT: ok');
} catch (e) {
  console.log('BOOT BLOCKED:');
  console.log((e as Error).message);
}