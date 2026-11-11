import dotenv from 'dotenv';
dotenv.config();

import { decryptKmsEnv } from './config/kms';

async function main(): Promise<void> {
  const decrypted = await decryptKmsEnv();
  if (decrypted.length > 0) {
    console.log(`[STARTUP] Decrypted KMS values in: ${decrypted.join(', ')}`);
  }
  await import('./server.js');
}

main().catch((error) => {
  console.error('[STARTUP] KMS decryption failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
