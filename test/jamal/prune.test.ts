import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planPrune,
  formatPrunePlan,
  planPruneExecution,
  JamalPruneError,
} from '../../src/jamal/prune.js';
import type { ImageRef, PruneExecutionInput } from '../../src/jamal/prune.js';

describe('planPrune', () => {
  it('keeps the N most recent images per service and removes the rest', () => {
    const images: ImageRef[] = [
      'ghcr.io/acme/myapp:def789', // newest
      'ghcr.io/acme/myapp:abc123',
      'ghcr.io/acme/myapp:456',
      'ghcr.io/acme/worker:v3', // newest worker
      'ghcr.io/acme/worker:v2',
    ];

    const plan = planPrune({ keep: 2, images });

    // Keep 2 myapp images: def789, abc123; remove 456
    // Keep 2 worker images: v3, v2; remove none (only 2)
    assert.deepEqual(plan.kept, [
      'ghcr.io/acme/myapp:def789',
      'ghcr.io/acme/myapp:abc123',
      'ghcr.io/acme/worker:v3',
      'ghcr.io/acme/worker:v2',
    ]);
    assert.deepEqual(plan.toRemove, ['ghcr.io/acme/myapp:456']);
  });

  it('keeps nothing to remove when the list fits within keep', () => {
    const images: ImageRef[] = ['ghcr.io/acme/myapp:v1', 'ghcr.io/acme/myapp:v0'];

    const plan = planPrune({ keep: 2, images });

    assert.deepEqual(plan.toRemove, []);
    assert.deepEqual(plan.kept, ['ghcr.io/acme/myapp:v1', 'ghcr.io/acme/myapp:v0']);
  });

  it('handles untagged images (no colon)', () => {
    const images: ImageRef[] = ['abc123', 'def456', 'ghi789'];

    const plan = planPrune({ keep: 1, images });

    // Each untagged image ref is its own service group since the ref is the
    // full string without a colon separator. With keep=1, each is kept.
    assert.deepEqual(plan.kept, ['abc123', 'def456', 'ghi789']);
    assert.deepEqual(plan.toRemove, []);
  });

  it('groups by repository prefix before the colon', () => {
    // Same service name "myapp" but different tags.
    const images: ImageRef[] = [
      'myapp:latest',
      'myapp:3ef7e2a',
      'myapp:abc123',
      'other:1',
      'other:2',
    ];

    const plan = planPrune({ keep: 1, images });

    assert.deepEqual(plan.kept, ['myapp:latest', 'other:1']);
    assert.deepEqual(plan.toRemove, ['myapp:3ef7e2a', 'myapp:abc123', 'other:2']);
  });

  it('refuses keep < 1', () => {
    assert.throws(
      () => planPrune({ keep: 0, images: [] }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        assert.match(error.message, /keep must be at least 1/);
        return true;
      },
    );

    assert.throws(
      () => planPrune({ keep: -1, images: ['img:1'] }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );
  });

  it('accepts keep = 1 (minimum)', () => {
    const images: ImageRef[] = ['myapp:a', 'myapp:b'];

    const plan = planPrune({ keep: 1, images });

    assert.deepEqual(plan.kept, ['myapp:a']);
    assert.deepEqual(plan.toRemove, ['myapp:b']);
  });

  it('groups images with same name but different registries separately', () => {
    const images: ImageRef[] = ['ghcr.io/acme/app:1', 'docker.io/acme/app:1', 'ghcr.io/acme/app:2'];

    const plan = planPrune({ keep: 1, images });

    // Two groups: "ghcr.io/acme/app" and "docker.io/acme/app"
    assert.equal(plan.kept.length, 2);
    assert.equal(plan.toRemove.length, 1);
  });

  it('returns an empty plan for an empty image list', () => {
    const plan = planPrune({ keep: 3, images: [] });

    assert.deepEqual(plan.toRemove, []);
    assert.deepEqual(plan.kept, []);
  });

  it('is deterministic for the same input', () => {
    const images: ImageRef[] = ['svc:a', 'svc:b', 'svc:c', 'svc:d'];

    const a = planPrune({ keep: 2, images });
    const b = planPrune({ keep: 2, images });

    assert.deepEqual(a, b);
  });
});

describe('formatPrunePlan', () => {
  it('renders images to remove and kept counts when there are removals', () => {
    const images: ImageRef[] = ['myapp:a', 'myapp:b', 'myapp:c'];
    const plan = planPrune({ keep: 1, images });
    const output = formatPrunePlan(plan);

    assert.match(output, /2 image\(s\) to remove/);
    assert.match(output, /myapp:b/);
    assert.match(output, /myapp:c/);
    assert.match(output, /Kept 1 image/);
  });

  it('renders "No images to prune" when nothing to remove', () => {
    const plan = planPrune({ keep: 2, images: ['myapp:a'] });
    const output = formatPrunePlan(plan);

    assert.match(output, /No images to prune/);
    assert.match(output, /Kept 1 image/);
  });
});

describe('planPruneExecution', () => {
  const server = 'app.example.com';

  it('images scope emits docker image prune argv', () => {
    const plan = planPruneExecution({ scope: 'images', retain: 48, server });

    assert.deepEqual(plan.argv, [
      'ssh',
      server,
      'docker',
      'image',
      'prune',
      '-a',
      '--force',
      '--filter',
      'until=48h',
    ]);
    assert.equal(plan.scope, 'images');
    assert.equal(plan.retain, 48);
  });

  it('containers scope emits docker container prune argv', () => {
    const plan = planPruneExecution({ scope: 'containers', retain: 1, server });

    assert.deepEqual(plan.argv, ['ssh', server, 'docker', 'container', 'prune', '--force']);
    assert.equal(plan.scope, 'containers');
    assert.equal(plan.retain, 1);
  });

  it('all scope emits docker system prune argv', () => {
    const plan = planPruneExecution({ scope: 'all', retain: 72, server });

    assert.deepEqual(plan.argv, ['ssh', server, 'docker', 'system', 'prune', '-a', '--force']);
    assert.equal(plan.scope, 'all');
    assert.equal(plan.retain, 72);
  });

  it('rejects retain < 1 value-free', () => {
    assert.throws(
      () => planPruneExecution({ scope: 'all', retain: 0, server }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        assert.match(error.message, /retain must be at least 1/);
        return true;
      },
    );

    assert.throws(
      () => planPruneExecution({ scope: 'images', retain: -1, server }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );
  });

  it('rejects server with whitespace', () => {
    assert.throws(
      () => planPruneExecution({ scope: 'all', retain: 1, server: 'host with space' }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );

    assert.throws(
      () => planPruneExecution({ scope: 'all', retain: 1, server: 'host\twith\ttab' }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );
  });

  it('rejects server with control characters', () => {
    assert.throws(
      () => planPruneExecution({ scope: 'all', retain: 1, server: 'host\u0000name' }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );
  });

  it('rejects empty server', () => {
    assert.throws(
      () => planPruneExecution({ scope: 'all', retain: 1, server: '' }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );
  });

  it('rejects server starting with dash', () => {
    assert.throws(
      () => planPruneExecution({ scope: 'all', retain: 1, server: '-o BatchMode=yes' }),
      (error: unknown) => {
        assert.ok(error instanceof JamalPruneError);
        return true;
      },
    );
  });

  it('accepts retain = 1 (minimum)', () => {
    const plan = planPruneExecution({ scope: 'images', retain: 1, server });
    assert.deepEqual(plan.argv, [
      'ssh',
      server,
      'docker',
      'image',
      'prune',
      '-a',
      '--force',
      '--filter',
      'until=1h',
    ]);
  });

  it('accepts standard server names', () => {
    const servers: PruneExecutionInput['server'][] = [
      '127.0.0.1',
      'app.example.com',
      'user@example.com',
      'ip-10-0-1-5.ec2.internal',
    ];

    for (const s of servers) {
      const plan = planPruneExecution({ scope: 'all', retain: 1, server: s });
      assert.deepEqual(plan.argv, ['ssh', s, 'docker', 'system', 'prune', '-a', '--force']);
    }
  });
});
