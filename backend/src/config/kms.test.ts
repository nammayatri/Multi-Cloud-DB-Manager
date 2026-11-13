import { describe, expect, it, vi } from 'vitest';

let inFlight = 0;
let maxInFlight = 0;

vi.mock('@aws-sdk/client-kms', () => ({
  DecryptCommand: class {
    constructor(public input: { CiphertextBlob: Uint8Array }) {}
  },
  KMSClient: class {
    async send(cmd: { input: { CiphertextBlob: Uint8Array } }) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { Plaintext: new Uint8Array(cmd.input.CiphertextBlob) };
    }
  },
}));

const { decryptKmsEnv } = await import('./kms');

const kms = (plain: string) => `kms:${Buffer.from(plain).toString('base64')}`;

describe('decryptKmsEnv', () => {
  it('decrypts plain, JSON and base64(JSON) values and leaves the rest alone', async () => {
    const config = { dbs: [{ host: kms('h1'), port: 5432, password: kms('p1') }] };
    const env: NodeJS.ProcessEnv = {
      PLAIN: 'unchanged',
      SECRET: kms('s3cret'),
      JSON_CFG: JSON.stringify(config),
      B64_CFG: Buffer.from(JSON.stringify(config)).toString('base64'),
    };
    const changed = await decryptKmsEnv(env);
    const expected = { dbs: [{ host: 'h1', port: 5432, password: 'p1' }] };
    expect(changed.sort()).toEqual(['B64_CFG', 'JSON_CFG', 'SECRET']);
    expect(env.PLAIN).toBe('unchanged');
    expect(env.SECRET).toBe('s3cret');
    expect(JSON.parse(env.JSON_CFG!)).toEqual(expected);
    expect(JSON.parse(Buffer.from(env.B64_CFG!, 'base64').toString())).toEqual(expected);
  });

  it('never runs more than 8 KMS calls at once, however many values a JSON holds', async () => {
    maxInFlight = 0;
    const many = Array.from({ length: 200 }, (_, i) => kms(`v${i}`));
    const env: NodeJS.ProcessEnv = { BIG: JSON.stringify(many) };
    await decryptKmsEnv(env);
    expect(JSON.parse(env.BIG!)).toEqual(many.map((_, i) => `v${i}`));
    expect(maxInFlight).toBe(8);
  });
});
