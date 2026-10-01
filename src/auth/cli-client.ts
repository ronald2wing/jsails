/**
 * CLI credentials client for the first-party `auth` plugin.
 *
 * Implements the OAuth 2.0 Device Authorization Grant (RFC 8628) against the
 * app's Better Auth device endpoints, so the CLI can sign in through the same
 * browser approval page (`/device`) the web app uses. It owns the credential
 * file on disk and the HTTP calls to `/api/auth/device/code`,
 * `/api/auth/device/token`, and `/api/me`; the app-side `commands/*` modules
 * wrap these helpers so `jsails login`, `jsails whoami`, and `jsails logout`
 * work.
 *
 * Credentials are stored at
 * `${XDG_CONFIG_HOME ?? ~/.config}/jsails/<appName>/credentials.json`, where
 * `<appName>` is the package name (or the working-directory basename when no
 * `package.json` is present). The directory is created `0700` and the file is
 * written atomically (temp file + rename) at `0600`, so other local users
 * cannot read the session token.
 *
 * Security: the `access_token` is a Better Auth session token. It is never
 * written to stdout/stderr and never embedded in an error message. The
 * `device_code` is kept private to this process; only the `user_code` — which
 * is meant to be shown to the user — is printed.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { isErrno } from '../internal/errors.js';

/** RFC 8628 client id; must match the server's `validateClient` allowlist. */
const CLIENT_ID = 'jsails-cli';

/** Default base URL when neither `APP_URL` nor `BETTER_AUTH_URL` is set. */
const DEFAULT_BASE_URL = 'http://localhost:3000';

/** Better Auth device grant type (RFC 8628). */
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Raise this for any CLI auth failure; its message is always safe to print. */
export class CliAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliAuthError';
  }
}

/** Credentials persisted to disk on a successful device login. */
export interface Credentials {
  baseUrl: string;
  token: string;
  tokenType: string;
  /** Epoch milliseconds at which the session token expires. */
  expiresAt: number;
  scope: string;
}

/** Options for {@link login}. */
export interface LoginOptions {
  /** App base URL. Defaults to `APP_URL`, then `BETTER_AUTH_URL`, then localhost. */
  baseUrl?: string;
  /** Best-effort open the approval URL in a browser. Defaults to `true`. */
  openBrowser?: boolean;
}

/** Device-code response from `POST /api/auth/device/code`. */
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/** Success and error response from `POST /api/auth/device/token`. */
interface DeviceTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** The authenticated user shape returned by `GET /api/me`. */
interface MeResponse {
  user: {
    id: string;
    name: string | null;
    email: string;
  };
}

/** Resolve the base URL from the environment, stripping any trailing slash. */
function resolveBaseUrl(explicit?: string): string {
  const baseUrl =
    explicit ?? process.env.APP_URL ?? process.env.BETTER_AUTH_URL ?? DEFAULT_BASE_URL;
  return baseUrl.replace(/\/+$/, '');
}

/** Resolve the app name used to namespace the credentials directory. */
async function resolveAppName(): Promise<string> {
  try {
    const text = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const manifest = JSON.parse(text) as { name?: unknown };
    if (typeof manifest.name === 'string' && manifest.name !== '') {
      return manifest.name;
    }
  } catch {
    // No readable package.json in the working directory; fall through.
  }
  return basename(process.cwd());
}

/** Resolve the absolute credentials file path for this app. */
async function credentialsPath(): Promise<string> {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const appName = await resolveAppName();
  return join(configHome, 'jsails', appName, 'credentials.json');
}

/**
 * Write credentials atomically: create the directory `0700`, write a temp file
 * in the same directory `0600`, then rename over the target. The temp file is
 * removed on a failed write so a crash never leaves a partial credentials file.
 */
async function writeCredentials(filePath: string, credentials: Credentials): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/** Read persisted credentials, or `undefined` when none exist or are corrupt. */
async function readCredentials(filePath: string): Promise<Credentials | undefined> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(text) as Partial<Credentials>;
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.token !== 'string') {
      return undefined;
    }
    return parsed as Credentials;
  } catch {
    return undefined;
  }
}

/** Delete persisted credentials; a missing file is a no-op. */
async function deleteCredentials(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  });
}

/** Best-effort, non-blocking open of a URL in the user's browser. */
function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // A missing opener emits 'error' rather than throwing; ignore it so the
    // user can open the printed URL manually.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort only.
  }
}

/** Parse a JSON response body, returning `undefined` when it is not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Pause for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the token endpoint until the user approves, the code expires, or the
 * code is denied. Honors `slow_down` by increasing the wait and bounds the
 * whole exchange by the server's `expires_in`.
 */
async function pollForToken(
  baseUrl: string,
  device: DeviceCodeResponse,
): Promise<{ access_token: string; token_type: string; expires_in: number; scope: string }> {
  const deadline = Date.now() + device.expires_in * 1000;
  let waitMs = device.interval * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new CliAuthError('timed out waiting for approval; run jsails login again');
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: device.device_code,
          client_id: CLIENT_ID,
        }),
      });
    } catch {
      throw new CliAuthError(`could not reach ${baseUrl}; is the app still running?`);
    }

    const body = (await readJson(response)) as DeviceTokenResponse | undefined;

    if (response.ok && typeof body?.access_token === 'string') {
      return {
        access_token: body.access_token,
        token_type: body.token_type ?? 'Bearer',
        expires_in: body.expires_in ?? 0,
        scope: body.scope ?? '',
      };
    }

    const errorCode = body?.error;
    if (errorCode === 'authorization_pending') {
      await sleep(waitMs);
      continue;
    }
    if (errorCode === 'slow_down') {
      waitMs += 5_000; // RFC 8628: increase the polling interval by 5 seconds.
      await sleep(waitMs);
      continue;
    }
    if (errorCode === 'expired_token') {
      throw new CliAuthError('the device code expired; run jsails login again');
    }
    if (errorCode === 'access_denied') {
      throw new CliAuthError('the device login was denied; run jsails login again');
    }
    throw new CliAuthError(
      body?.error_description ?? `device token exchange failed (${response.status})`,
    );
  }
}

/**
 * Sign in via the device flow. Requests a device code, prints the user code and
 * approval URL, best-effort opens the browser, and polls until approval, then
 * stores the session credentials on disk. Throws {@link CliAuthError} with a
 * safe message on any failure; the access token is never printed.
 */
export async function login(options: LoginOptions = {}): Promise<void> {
  const baseUrl = resolveBaseUrl(options.baseUrl);

  let device: DeviceCodeResponse;
  try {
    const response = await fetch(`${baseUrl}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID }),
    });
    if (!response.ok) {
      const body = (await readJson(response)) as { error_description?: string } | undefined;
      throw new CliAuthError(
        body?.error_description ?? `device code request failed (${response.status})`,
      );
    }
    device = (await response.json()) as DeviceCodeResponse;
  } catch (error) {
    if (error instanceof CliAuthError) {
      throw error;
    }
    throw new CliAuthError(`could not reach ${baseUrl}; is the app running?`);
  }

  console.log('To sign in, open this URL and approve the device:');
  console.log('');
  console.log(`  ${device.verification_uri_complete}`);
  console.log('');
  console.log(`  Code: ${device.user_code}`);
  console.log('');
  console.log('Waiting for approval...');

  if (options.openBrowser !== false) {
    openBrowser(device.verification_uri_complete);
  }

  const token = await pollForToken(baseUrl, device);

  await writeCredentials(await credentialsPath(), {
    baseUrl,
    token: token.access_token,
    tokenType: token.token_type,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
  });

  console.log('Signed in.');
}

/**
 * Print the signed-in account (`name <email>`, or just the email). Throws
 * {@link CliAuthError} when not signed in or when the session has expired; an
 * expired session (reported by the server as 401/403, or detected locally from
 * `expiresAt`) deletes the stale credentials so the next `jsails whoami` fails
 * clean with "not signed in" rather than an expired token.
 */
export async function whoami(): Promise<void> {
  const filePath = await credentialsPath();
  const credentials = await readCredentials(filePath);
  if (credentials === undefined) {
    throw new CliAuthError('not signed in; run jsails login');
  }

  if (credentials.expiresAt <= Date.now()) {
    await deleteCredentials(filePath);
    throw new CliAuthError('session expired; run jsails login');
  }

  let response: Response;
  try {
    response = await fetch(`${credentials.baseUrl}/api/me`, {
      headers: { authorization: `Bearer ${credentials.token}` },
    });
  } catch {
    throw new CliAuthError(`could not reach ${credentials.baseUrl}; is the app running?`);
  }

  // The app's global authorize is default-deny, so an expired or invalid bearer
  // token is rejected before /api/me runs. Treat both 401 and 403 as an expired
  // session and drop the stale credentials.
  if (response.status === 401 || response.status === 403) {
    await deleteCredentials(filePath);
    throw new CliAuthError('session expired; run jsails login');
  }
  if (!response.ok) {
    throw new CliAuthError(`could not read your account (${response.status})`);
  }

  const body = (await readJson(response)) as MeResponse | undefined;
  const user = body?.user;
  if (user === undefined || typeof user.email !== 'string') {
    throw new CliAuthError('unexpected response from /api/me');
  }

  const identity =
    user.name !== null && user.name.trim() !== '' ? `${user.name} <${user.email}>` : user.email;
  console.log(identity);
}

/**
 * Delete the stored credentials. Idempotent: signing out when not signed in is
 * a no-op that still reports success.
 */
export async function logout(): Promise<void> {
  await deleteCredentials(await credentialsPath());
  console.log('Signed out.');
}
