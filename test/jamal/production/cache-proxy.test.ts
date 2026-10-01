import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CacheProxyError,
  CACHE_PROXY_CONTAINER_NAME,
  CACHE_PROXY_IMAGE_DEFAULT,
  CACHE_PROXY_PORT_DEFAULT,
  CACHE_PROXY_SIZE_DEFAULT,
  CACHE_PROXY_VCL_PATH,
  DEFAULT_VCL,
  cacheProxyBoot,
  cacheProxyBootArgv,
  cacheProxyHealthArgv,
  cacheProxyListArgv,
  cacheProxyStatus,
  cacheProxyStatusArgv,
  cacheProxyWriteVclArgv,
  resolveVcl,
} from '../../../src/jamal/production/cache-proxy.js';
import type { CommandResult } from '../../../src/jamal/production/command-runner.js';
import type { RemoteRunner } from '../../../src/jamal/production/transport.js';

/**
 * Tests for the Varnish cache-proxy accessory. The pure argv builders are
 * asserted directly (exact argv shapes and validation), the default VCL
 * constant is checked for the required pass-guards, and the executors run
 * against a recording fake {@link RemoteRunner} so no ssh or docker command
 * is ever spawned.
 */

interface RecordedCall {
  server: string;
  remoteArgv: string[];
}

function makeRemote(script: (server: string, remoteArgv: string[]) => CommandResult): {
  remote: RemoteRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const remote: RemoteRunner = {
    async run(server, remoteArgv) {
      calls.push({ server, remoteArgv: [...remoteArgv] });
      return script(server, [...remoteArgv]);
    },
  };
  return { remote, calls };
}

const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

function capture(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof CacheProxyError, `expected CacheProxyError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected a CacheProxyError, but nothing was thrown');
}

describe('cacheProxyBootArgv: argv shape', () => {
  it('emits the default boot argv', () => {
    assert.deepEqual(cacheProxyBootArgv(), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      CACHE_PROXY_CONTAINER_NAME,
      '-e',
      `VARNISH_SIZE=${CACHE_PROXY_SIZE_DEFAULT}`,
      '-p',
      `127.0.0.1:${CACHE_PROXY_PORT_DEFAULT}:${CACHE_PROXY_PORT_DEFAULT}`,
      '-v',
      `${CACHE_PROXY_VCL_PATH}:${CACHE_PROXY_VCL_PATH}:ro`,
      CACHE_PROXY_IMAGE_DEFAULT,
    ]);
  });

  it('honors a custom image and size', () => {
    assert.deepEqual(cacheProxyBootArgv({ image: 'varnish:7.6', size: '512m' }), [
      'docker',
      'run',
      '-d',
      '--restart',
      'unless-stopped',
      '--name',
      CACHE_PROXY_CONTAINER_NAME,
      '-e',
      'VARNISH_SIZE=512m',
      '-p',
      `127.0.0.1:${CACHE_PROXY_PORT_DEFAULT}:${CACHE_PROXY_PORT_DEFAULT}`,
      '-v',
      `${CACHE_PROXY_VCL_PATH}:${CACHE_PROXY_VCL_PATH}:ro`,
      'varnish:7.6',
    ]);
  });

  it('exposes the documented default constants', () => {
    assert.equal(CACHE_PROXY_IMAGE_DEFAULT, 'varnish:7.7');
    assert.equal(CACHE_PROXY_SIZE_DEFAULT, '256m');
    assert.equal(CACHE_PROXY_PORT_DEFAULT, 6081);
    assert.equal(CACHE_PROXY_CONTAINER_NAME, 'jamal-cache-proxy');
  });
});

describe('cacheProxyWriteVclArgv: argv shape', () => {
  it('emits a base64-encoded sh -c command', () => {
    const vcl = 'vcl 4.1;\nbackend default { .host = "app"; }';
    const argv = cacheProxyWriteVclArgv(vcl);
    assert.equal(argv[0], 'sh');
    assert.equal(argv[1], '-c');
    // The third element is the sh -c script with base64-encoded VCL.
    const script = argv[2] as string;
    assert.ok(script.startsWith("echo '"), 'must start with echo base64');
    assert.ok(script.includes("' | base64 -d > "), 'must decode to VCL path');
  });

  it('rejects an empty VCL', () => {
    const error = capture(() => cacheProxyWriteVclArgv(''));
    assert.match(error.message, /VCL content must be a non-empty string/);
  });
});

describe('cacheProxyStatusArgv / cacheProxyListArgv / cacheProxyHealthArgv', () => {
  it('queries status with docker inspect', () => {
    assert.deepEqual(cacheProxyStatusArgv(), ['docker', 'inspect', CACHE_PROXY_CONTAINER_NAME]);
  });

  it('lists containers filtered by name', () => {
    assert.deepEqual(cacheProxyListArgv(), [
      'docker',
      'ps',
      '--filter',
      `name=${CACHE_PROXY_CONTAINER_NAME}`,
    ]);
  });

  it('health-checks with varnishlog', () => {
    assert.deepEqual(cacheProxyHealthArgv(), [
      'docker',
      'exec',
      CACHE_PROXY_CONTAINER_NAME,
      'varnishlog',
      '-c',
      '-n',
      '/tmp',
    ]);
  });
});

describe('cacheProxy validation: value-free errors', () => {
  it('rejects a whitespace image name', () => {
    const error = capture(() => cacheProxyBootArgv({ image: 'has space' }));
    assert.match(error.message, /must not contain whitespace/);
    assert.ok(!error.message.includes('has space'), 'the rejected value must not leak');
  });

  it('rejects an empty image name', () => {
    const error = capture(() => cacheProxyBootArgv({ image: '' }));
    assert.match(error.message, /must be a non-empty string/);
  });

  it('rejects an image starting with "-"', () => {
    const error = capture(() => cacheProxyBootArgv({ image: '-bad' }));
    assert.match(error.message, /must not start with/);
  });

  it('rejects a control character in the image name', () => {
    const error = capture(() => cacheProxyBootArgv({ image: 'img\u0001' }));
    assert.match(error.message, /must not contain whitespace or control characters/);
  });

  it('rejects a malformed VCL in writeVclArgv', () => {
    const error = capture(() => cacheProxyWriteVclArgv(''));
    assert.match(error.message, /VCL content must be a non-empty string/);
  });
});

describe('resolveVcl: backend host and port replacement', () => {
  it('replaces the placeholder host and port', () => {
    const vcl = resolveVcl('myapp-web-abc123', 3000);
    assert.ok(!vcl.includes('__BACKEND_HOST__'), 'placeholder must be replaced');
    assert.ok(!vcl.includes('__BACKEND_PORT__'), 'placeholder must be replaced');
    assert.ok(vcl.includes('.host = "myapp-web-abc123"'));
    assert.ok(vcl.includes('.port = "3000"'));
  });

  it('defaults the port to 3000', () => {
    const vcl = resolveVcl('myapp-web-xyz');
    assert.ok(vcl.includes('.port = "3000"'));
  });

  it('rejects an empty host', () => {
    const error = capture(() => resolveVcl('', 3000));
    assert.match(error.message, /must be a non-empty string/);
  });

  it('rejects a port of 0 or 65536', () => {
    const error = capture(() => resolveVcl('app', 0));
    assert.match(error.message, /must be an integer between 1/);

    const error2 = capture(() => resolveVcl('app', 65536));
    assert.match(error2.message, /must be an integer between 1/);
  });
});

describe('resolveVcl: cookie allowlist', () => {
  it('keeps the pass-on-any-cookie block when no allowlist is given', () => {
    const vcl = resolveVcl('app', 3000);
    assert.ok(vcl.includes('  if (req.http.Cookie) {'));
    assert.ok(vcl.includes('    return (pass);'));
    assert.ok(!vcl.includes('regsuball'), 'no allowlist means no regsuball stripping');
  });

  it('keeps the pass-on-any-cookie block when the allowlist is empty', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: [] });
    assert.ok(!vcl.includes('regsuball'), 'an empty allowlist is the default policy');
  });

  it('replaces the pass block with allowlist stripping when names are given', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: ['session_id'] });
    assert.ok(!vcl.includes('  if (req.http.Cookie) {\n    return (pass);\n  }'));
    assert.ok(
      vcl.includes('regsuball(req.http.Cookie, "(^|; *)session_id=[^;]*", "")'),
      'must strip the allowlisted cookie',
    );
    assert.ok(vcl.includes('if (req.http.Cookie ~ "^[; ]*$")'), 'must detect "no cookies left"');
    assert.ok(vcl.includes('unset req.http.Cookie;'), 'must unset when only separators remain');
    assert.ok(vcl.includes('return (pass);'), 'must pass when another cookie remains');
  });

  it('strips multiple allowlisted names in order', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: ['a', 'b'] });
    const aIndex = vcl.indexOf('regsuball(req.http.Cookie, "(^|; *)a=[^;]*", "")');
    const bIndex = vcl.indexOf('regsuball(req.http.Cookie, "(^|; *)b=[^;]*", "")');
    assert.ok(aIndex >= 0 && bIndex >= 0, 'both names must be stripped');
    assert.ok(aIndex < bIndex, 'names strip in declaration order');
  });

  it('escapes regex metacharacters in a cookie name', () => {
    const vcl = resolveVcl('app', 3000, { cookieAllowlist: ['__utm*'] });
    assert.ok(
      vcl.includes('regsuball(req.http.Cookie, "(^|; *)__utm\\*=[^;]*", "")'),
      'the "*" must be escaped so the name matches literally',
    );
  });

  it('rejects an empty allowlist entry', () => {
    const error = capture(() => resolveVcl('app', 3000, { cookieAllowlist: [''] }));
    assert.match(error.message, /non-empty/);
  });

  it('rejects a whitespace allowlist entry', () => {
    const error = capture(() => resolveVcl('app', 3000, { cookieAllowlist: ['has space'] }));
    assert.match(error.message, /whitespace or control/);
    assert.ok(!error.message.includes('has space'), 'the rejected value must not leak');
  });

  it('rejects a quote or backslash in an allowlist entry', () => {
    const quote = capture(() => resolveVcl('app', 3000, { cookieAllowlist: ['a"b'] }));
    assert.match(quote.message, /quotes or backslashes/);

    const backslash = capture(() => resolveVcl('app', 3000, { cookieAllowlist: ['a\\b'] }));
    assert.match(backslash.message, /quotes or backslashes/);
  });
});

describe('DEFAULT_VCL: required pass-guards and cache policy', () => {
  it('contains a pass for non-GET/HEAD methods', () => {
    assert.ok(
      DEFAULT_VCL.includes('req.method != "GET"') &&
        DEFAULT_VCL.includes('req.method != "HEAD"') &&
        DEFAULT_VCL.includes('return (pass)'),
      'must pass non-GET/HEAD requests',
    );
  });

  it('contains a pass for /_jsails/ paths', () => {
    assert.ok(
      DEFAULT_VCL.includes('^/_jsails/') && DEFAULT_VCL.includes('return (pass)'),
      'must pass JSails internal paths',
    );
  });

  it('contains a pass for Cookie-bearing requests', () => {
    assert.ok(
      DEFAULT_VCL.includes('req.http.Cookie') && DEFAULT_VCL.includes('return (pass)'),
      'must pass requests with cookies',
    );
  });

  it('strips cookies for cacheable requests', () => {
    assert.ok(
      DEFAULT_VCL.includes('unset req.http.Cookie'),
      'must strip cookies from cacheable requests',
    );
  });

  it('default-denies caching in vcl_backend_response', () => {
    assert.ok(DEFAULT_VCL.includes('set beresp.uncacheable = true'), 'must default to uncacheable');
  });

  it('never stores a response with Set-Cookie', () => {
    assert.ok(
      DEFAULT_VCL.includes('beresp.http.Set-Cookie') &&
        DEFAULT_VCL.includes('set beresp.uncacheable = true'),
      'must not store Set-Cookie responses',
    );
  });

  it('sets beresp.grace', () => {
    assert.ok(DEFAULT_VCL.includes('set beresp.grace = 1h'), 'must set grace period');
  });

  it('checks Surrogate-Control and Cache-Control', () => {
    assert.ok(
      DEFAULT_VCL.includes('beresp.http.Surrogate-Control'),
      'must check Surrogate-Control',
    );
    assert.ok(DEFAULT_VCL.includes('beresp.http.Cache-Control'), 'must check Cache-Control');
  });

  it('sets X-Cache HIT/MISS headers in vcl_deliver', () => {
    assert.ok(
      DEFAULT_VCL.includes('X-Cache') &&
        DEFAULT_VCL.includes('"HIT"') &&
        DEFAULT_VCL.includes('"MISS"'),
      'must set X-Cache debug header',
    );
  });
});

describe('cacheProxyBoot: executor', () => {
  it('boots the container via the remote runner and resolves on success', async () => {
    const { remote, calls } = makeRemote(() => ok);
    await cacheProxyBoot(remote, '1.2.3.4', {});

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.server, '1.2.3.4');
    assert.deepEqual(calls[0]!.remoteArgv, cacheProxyBootArgv());
  });

  it('throws a value-free CacheProxyError on non-zero exit', async () => {
    const errorExit: CommandResult = { exitCode: 1, stdout: '', stderr: 'sensitive output' };
    const { remote } = makeRemote(() => errorExit);

    await assert.rejects(
      () => cacheProxyBoot(remote, '1.2.3.4', {}),
      (error: unknown) => {
        assert.ok(error instanceof CacheProxyError);
        const message = error.message;
        assert.match(message, /cache-proxy boot/);
        assert.ok(!message.includes('sensitive output'), 'error must be value-free');
        return true;
      },
    );
  });
});

describe('cacheProxyStatus: executor', () => {
  it('resolves true on exit zero', async () => {
    const { remote } = makeRemote(() => ok);
    const present = await cacheProxyStatus(remote, '1.2.3.4');
    assert.equal(present, true);
  });

  it('resolves false on non-zero exit without throwing', async () => {
    const errorExit: CommandResult = { exitCode: 1, stdout: '', stderr: '' };
    const { remote } = makeRemote(() => errorExit);
    const present = await cacheProxyStatus(remote, '1.2.3.4');
    assert.equal(present, false);
  });
});
