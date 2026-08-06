import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
// `selfsigned`'s types declare only a named `generate` export (no default),
// so this must be a namespace import even under `esModuleInterop`.
import * as selfsigned from 'selfsigned';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Fixed by contract with WS-04: the app is started with `COGNITO_JWKS_URI`
 * already pointing here (see `playwright.config.ts`'s `webServer.env`), so
 * this port cannot float per-run the way an ephemeral port would.
 */
export const JWKS_PORT = 3001;

/**
 * `aws-jwt-verify`'s JWKS fetcher (`packages/auth/src/verify-token.ts`) is
 * built on Node's `https` module unconditionally — it throws
 * `Protocol "http:" not supported. Expected "https:"` for a plain-HTTP
 * issuer, verified empirically against this exact dependency version. The
 * server therefore terminates TLS with a locally generated, self-signed
 * certificate rather than serving plain HTTP, and the app process trusts
 * that certificate via `NODE_EXTRA_CA_CERTS` (see `CA_CERT_PATH` below and
 * `playwright.config.ts`).
 */
export const ISSUER = `https://localhost:${JWKS_PORT}`;
export const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

// Persisted so the JWKS HTTP server (started once in globalSetup) and the
// token-signing fixture (imported fresh into each test worker process) sign
// and publish the same key material instead of generating independent,
// mutually-unverifiable keys.
const KEYS_DIR = join(__dirname, '..', '.e2e-keys');
const SIGNING_KEY_PATH = join(KEYS_DIR, 'signing-key.json');
const TLS_CERT_PATH = join(KEYS_DIR, 'tls-cert.pem');
const TLS_KEY_PATH = join(KEYS_DIR, 'tls-key.pem');

/** Path the app process's `NODE_EXTRA_CA_CERTS` must point at. */
export const CA_CERT_PATH = TLS_CERT_PATH;

const KEY_ID = 'e2e-signing-key';

interface SigningKeyMaterial {
  readonly privateJwk: JWK;
  readonly publicJwk: JWK;
}

async function ensureSigningKeyPair(): Promise<SigningKeyMaterial> {
  mkdirSync(KEYS_DIR, { recursive: true });

  if (existsSync(SIGNING_KEY_PATH)) {
    return JSON.parse(readFileSync(SIGNING_KEY_PATH, 'utf-8')) as SigningKeyMaterial;
  }

  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const privateJwk: JWK = { ...(await exportJWK(privateKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: 'RS256', use: 'sig' };

  const material: SigningKeyMaterial = { privateJwk, publicJwk };
  writeFileSync(SIGNING_KEY_PATH, JSON.stringify(material), 'utf-8');
  return material;
}

async function ensureTlsCertificate(): Promise<{ cert: string; key: string }> {
  mkdirSync(KEYS_DIR, { recursive: true });

  if (existsSync(TLS_CERT_PATH) && existsSync(TLS_KEY_PATH)) {
    return { cert: readFileSync(TLS_CERT_PATH, 'utf-8'), key: readFileSync(TLS_KEY_PATH, 'utf-8') };
  }

  // Default extensions cover the SANs `localhost` requires (DNS name plus
  // the 127.0.0.1 IP SAN) — see the `selfsigned` README's "Default
  // Extensions" section.
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    keySize: 2048,
  });
  writeFileSync(TLS_CERT_PATH, pems.cert, 'utf-8');
  writeFileSync(TLS_KEY_PATH, pems.private, 'utf-8');
  return { cert: pems.cert, key: pems.private };
}

/**
 * Generates (or loads, if already persisted) the signing key and TLS
 * certificate without starting the HTTP listener. `playwright.config.ts`
 * awaits this at module scope, before constructing the `webServer.env` map,
 * so `NODE_EXTRA_CA_CERTS` always names a file that already exists by the
 * time the Next.js process starts — `NODE_EXTRA_CA_CERTS` is read once at
 * process start, so generating the certificate later (e.g. only inside
 * `globalSetup`) would be too late if the dev server happens to boot first.
 */
export async function ensureKeyMaterial(): Promise<void> {
  await Promise.all([ensureSigningKeyPair(), ensureTlsCertificate()]);
}

// Module-scoped, not returned from `startJwksServer`: `global-setup.ts` and
// `global-teardown.ts` are separate files, but Playwright loads both into
// the same root process for a given run, so this survives between them the
// same way any other module-level singleton would.
let runningServer: Server | undefined;

/**
 * Starts the local JWKS HTTPS server. Idempotent: a second call while a
 * server is already running is a no-op, so re-running `globalSetup` locally
 * (e.g. after a crashed previous run) cannot throw `EADDRINUSE`.
 */
export async function startJwksServer(): Promise<void> {
  if (runningServer !== undefined) {
    return;
  }

  const [{ publicJwk }, { cert, key }] = await Promise.all([ensureSigningKeyPair(), ensureTlsCertificate()]);

  const server = createServer({ cert, key }, (req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(JWKS_PORT, resolve);
  });

  runningServer = server;
}

export async function stopJwksServer(): Promise<void> {
  if (runningServer === undefined) {
    return;
  }
  const server = runningServer;
  runningServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export interface SignIdTokenInput {
  readonly cognitoSub: string;
  readonly audience: string;
  readonly email?: string;
}

/**
 * Signs an ID token against the persisted private key, shaped to satisfy
 * `packages/auth/src/verify-token.ts`: a `token_use: 'id'` claim (required
 * by `validateCognitoJwtFields`) and an `aud` matching `COGNITO_CLIENT_ID`.
 */
export async function signIdToken(input: SignIdTokenInput): Promise<string> {
  const { privateJwk } = await ensureSigningKeyPair();
  const signingKey = await importJWK(privateJwk, 'RS256');

  const builder = new SignJWT({ token_use: 'id', ...(input.email !== undefined ? { email: input.email } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(input.audience)
    .setSubject(input.cognitoSub)
    .setExpirationTime('2h');

  return builder.sign(signingKey);
}
