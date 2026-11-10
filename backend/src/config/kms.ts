import https from 'node:https';
import { KMSClient, DecryptCommand } from '@aws-sdk/client-kms';

const KMS_PREFIX = 'kms:';

let client: KMSClient | undefined;

function kmsClient(): KMSClient {
  if (!client) {
    // The SDK builds its own https agent, which ignores NODE_USE_ENV_PROXY; proxyEnv sends its STS and KMS calls through HTTPS_PROXY.
    client = new KMSClient({
      region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
      requestHandler: { httpsAgent: new https.Agent({ keepAlive: true, proxyEnv: process.env } as https.AgentOptions) },
    });
  }
  return client;
}

export async function decryptKmsValue(value: string): Promise<string> {
  if (!value.startsWith(KMS_PREFIX)) {
    return value;
  }
  const ciphertext = Buffer.from(value.slice(KMS_PREFIX.length).replace(/\s+/g, ''), 'base64');
  try {
    const out = await kmsClient().send(new DecryptCommand({ CiphertextBlob: ciphertext }));
    if (!out.Plaintext) {
      throw new Error('empty plaintext');
    }
    return Buffer.from(out.Plaintext).toString('utf-8');
  } catch (error) {
    throw new Error(`KMS decrypt failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function decryptTree(node: unknown): Promise<unknown> {
  if (typeof node === 'string') {
    return decryptKmsValue(node);
  }
  if (Array.isArray(node)) {
    return Promise.all(node.map(decryptTree));
  }
  if (node && typeof node === 'object') {
    const entries = await Promise.all(
      Object.entries(node).map(async ([key, val]) => [key, await decryptTree(val)] as const)
    );
    return Object.fromEntries(entries);
  }
  return node;
}

function looksLikeJson(text: string): boolean {
  const first = text.trimStart()[0];
  return first === '{' || first === '[';
}

const BASE64_ONLY = /^[A-Za-z0-9+/=\s]+$/;

async function decryptEnvValue(raw: string): Promise<string | null> {
  if (raw.startsWith(KMS_PREFIX)) {
    return decryptKmsValue(raw);
  }
  if (raw.includes(KMS_PREFIX) && looksLikeJson(raw)) {
    return JSON.stringify(await decryptTree(JSON.parse(raw)));
  }
  if (raw.length > 32 && BASE64_ONLY.test(raw)) {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    if (decoded.includes(KMS_PREFIX) && looksLikeJson(decoded)) {
      const tree = await decryptTree(JSON.parse(decoded));
      return Buffer.from(JSON.stringify(tree), 'utf-8').toString('base64');
    }
  }
  return null;
}

export async function decryptKmsEnv(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const changed: string[] = [];
  for (const [name, raw] of Object.entries(env)) {
    if (!raw) {
      continue;
    }
    let decrypted: string | null;
    try {
      decrypted = await decryptEnvValue(raw);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (decrypted !== null) {
      env[name] = decrypted;
      changed.push(name);
    }
  }
  return changed;
}
