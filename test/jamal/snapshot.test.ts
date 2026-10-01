import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planSnapshot,
  planRestore,
  planImportDb,
  planExportDb,
  formatSnapshotPlan,
  JamalSnapshotError,
} from '../../src/jamal/snapshot.js';

describe('planSnapshot', () => {
  it('builds a gzip-piped mariadb-dump argv for the mariadb driver', () => {
    const plan = planSnapshot({ service: 'db', driver: 'mariadb' });

    assert.equal(plan.argv[0], 'docker');
    assert.equal(plan.argv[1], 'compose');
    assert.equal(plan.argv[2], 'exec');
    assert.equal(plan.argv[3], '-T');
    assert.equal(plan.argv[4], 'db');
    assert.equal(plan.argv[5], 'sh');
    assert.equal(plan.argv[6], '-c');

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('mariadb-dump'));
    assert.ok(shell.includes('mysqldump'));
    assert.ok(shell.includes('gzip'));
    assert.ok(shell.includes('/tmp/'));
    assert.ok(plan.filename.endsWith('.sql.gz'));
    assert.match(plan.label, /snapshot db ->/);
  });

  it('builds a pg_dumpall argv for the postgres driver', () => {
    const plan = planSnapshot({ service: 'pg', driver: 'postgres' });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('pg_dumpall'));
    assert.ok(shell.includes('gzip'));
    assert.ok(plan.filename.endsWith('.sql.gz'));
  });

  it('uses a custom snapshot name', () => {
    const plan = planSnapshot({ service: 'db', name: 'before-migration', driver: 'mariadb' });

    assert.ok(plan.filename.startsWith('before-migration_'));
    assert.match(plan.filename, /\.sql\.gz$/);
  });

  it('sanitizes the name to a safe filename', () => {
    const plan = planSnapshot({
      service: 'db',
      name: 'my/snapshot: [v1]',
      driver: 'mariadb',
    });

    // Slashes, colons, brackets, spaces should be replaced.
    assert.ok(!plan.filename.includes('/'));
    assert.ok(!plan.filename.includes(':'));
    assert.ok(!plan.filename.includes('['));
    assert.ok(!plan.filename.includes(' '));
    // Colon and brackets each become '_'. 'my/snapshot: [v1]' -> 'my_snapshot___v1_'
    assert.match(plan.filename, /^my_snapshot___v1_/);
  });

  it('strips leading/trailing underscores after sanitization', () => {
    const plan = planSnapshot({
      service: 'db',
      name: '__test__',
      driver: 'mariadb',
    });

    assert.ok(plan.filename.startsWith('test_'));
  });

  it('defaults the name to the service name when empty or undefined', () => {
    const a = planSnapshot({ service: 'mariadb', driver: 'mariadb' });
    const b = planSnapshot({ service: 'mariadb', name: '', driver: 'mariadb' });

    assert.ok(a.filename.startsWith('mariadb_'));
    assert.ok(b.filename.startsWith('mariadb_'));
  });

  it('throws for an unsupported driver', () => {
    assert.throws(
      () => planSnapshot({ service: 'db', driver: 'mysql' as never }),
      (error: unknown) => {
        assert.ok(error instanceof JamalSnapshotError);
        assert.match(error.message, /unsupported/);
        return true;
      },
    );
  });
});

describe('planRestore', () => {
  it('builds a gunzip-piped mysql argv for mariadb', () => {
    const plan = planRestore({
      service: 'db',
      snapshotPath: '/tmp/myapp_2024.sql.gz',
      driver: 'mariadb',
    });

    assert.equal(plan.argv[0], 'docker');
    assert.equal(plan.argv[1], 'compose');
    assert.equal(plan.argv[2], 'exec');
    assert.equal(plan.argv[3], '-T');
    assert.equal(plan.argv[4], 'db');
    assert.equal(plan.argv[5], 'sh');
    assert.equal(plan.argv[6], '-c');

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('gunzip'));
    assert.ok(shell.includes('mysql'));
    assert.ok(shell.includes('/tmp/myapp_2024.sql.gz'));
    assert.match(plan.label, /restore db <-/);
  });

  it('builds a gunzip-piped psql argv for postgres', () => {
    const plan = planRestore({
      service: 'pg',
      snapshotPath: '/snapshots/dump.sql.gz',
      driver: 'postgres',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('gunzip'));
    assert.ok(shell.includes('psql'));
    assert.ok(shell.includes('/snapshots/dump.sql.gz'));
  });

  it('extracts the filename from the snapshot path for the label', () => {
    const plan = planRestore({
      service: 'db',
      snapshotPath: '/var/snapshots/before-migrate.sql.gz',
      driver: 'mariadb',
    });

    assert.equal(plan.filename, 'before-migrate.sql.gz');
    assert.match(plan.label, /before-migrate.sql.gz/);
  });

  it('throws for an unsupported restore driver', () => {
    assert.throws(
      () =>
        planRestore({
          service: 'db',
          snapshotPath: '/tmp/dump.sql.gz',
          driver: 'mysql' as never,
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalSnapshotError);
        assert.match(error.message, /unsupported/);
        return true;
      },
    );
  });
});

describe('planImportDb', () => {
  it('emits a gunzip-piped restore argv for .sql.gz mariadb', () => {
    const plan = planImportDb({
      service: 'db',
      hostPath: '/home/user/dump.sql.gz',
      driver: 'mariadb',
      format: 'sql.gz',
    });

    assert.equal(plan.argv[0], 'docker');
    assert.equal(plan.argv[1], 'compose');
    assert.equal(plan.argv[2], 'exec');
    assert.equal(plan.argv[3], '-T');
    assert.equal(plan.argv[4], 'db');
    assert.equal(plan.argv[5], 'sh');
    assert.equal(plan.argv[6], '-c');

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('gunzip -c'));
    assert.ok(shell.includes('mysql'));
    assert.ok(!shell.includes('mariadb-dump'));
    assert.equal(plan.filename, 'dump.sql.gz');
    assert.match(plan.label, /import-db db <- dump\.sql\.gz/);
  });

  it('emits a plain mysql restore for .sql mariadb', () => {
    const plan = planImportDb({
      service: 'maria',
      hostPath: '/var/backups/app.sql',
      driver: 'mariadb',
      format: 'sql',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('mysql'));
    assert.ok(!shell.includes('gunzip'));
    assert.ok(!shell.includes('tar'));
    assert.equal(plan.filename, 'app.sql');
  });

  it('emits a gunzip-piped psql restore for .mysql postgres', () => {
    const plan = planImportDb({
      service: 'pg',
      hostPath: '/tmp/export.mysql',
      driver: 'postgres',
      format: 'mysql',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('gunzip -c'));
    assert.ok(shell.includes('psql'));
    assert.equal(plan.filename, 'export.mysql');
  });

  it('emits tar extract pipeline for .tar format', () => {
    const plan = planImportDb({
      service: 'db',
      hostPath: '/tmp/dump.tar',
      driver: 'mariadb',
      format: 'tar',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('tar xOf'));
    assert.ok(shell.includes('mysql'));
    assert.equal(plan.filename, 'dump.tar');
  });

  it('emits unzip pipeline for .zip format', () => {
    const plan = planImportDb({
      service: 'db',
      hostPath: '/tmp/dump.zip',
      driver: 'postgres',
      format: 'zip',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('unzip -p'));
    assert.ok(shell.includes('psql'));
    assert.equal(plan.filename, 'dump.zip');
  });

  it('rejects an unsupported format value-free', () => {
    assert.throws(
      () =>
        planImportDb({
          service: 'db',
          hostPath: '/tmp/dump.csv',
          driver: 'mariadb',
          format: 'csv' as never,
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalSnapshotError);
        assert.match(error.message, /unsupported file format/);
        return true;
      },
    );
  });

  it('rejects an unsupported driver value-free', () => {
    assert.throws(
      () =>
        planImportDb({
          service: 'db',
          hostPath: '/tmp/dump.sql',
          driver: 'mysql' as never,
          format: 'sql',
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalSnapshotError);
        assert.match(error.message, /unsupported driver/);
        return true;
      },
    );
  });
});

describe('planExportDb', () => {
  it('emits a plain dump for .sql mariadb', () => {
    const plan = planExportDb({
      service: 'db',
      hostPath: '/tmp/out.sql',
      driver: 'mariadb',
      format: 'sql',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('mariadb-dump'));
    assert.ok(shell.includes('mysqldump'));
    assert.ok(!shell.includes('gzip'));
    assert.ok(!shell.includes('tar'));
    assert.equal(plan.filename, 'out.sql');
    assert.match(plan.label, /export-db db -> out\.sql/);
  });

  it('emits a gzip-compressed dump for .sql.gz postgres', () => {
    const plan = planExportDb({
      service: 'pg',
      hostPath: '/var/dumps/pg.sql.gz',
      driver: 'postgres',
      format: 'sql.gz',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('pg_dumpall'));
    assert.ok(shell.includes('gzip'));
    assert.equal(plan.filename, 'pg.sql.gz');
  });

  it('emits a tar archive pipeline for .tar format', () => {
    const plan = planExportDb({
      service: 'db',
      hostPath: '/tmp/out.tar',
      driver: 'mariadb',
      format: 'tar',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('mariadb-dump'));
    assert.ok(shell.includes('tar cf -'));
    assert.ok(shell.includes('_jamal_export.sql'));
    assert.equal(plan.filename, 'out.tar');
  });

  it('emits a zip archive pipeline for .zip format', () => {
    const plan = planExportDb({
      service: 'db',
      hostPath: '/tmp/out.zip',
      driver: 'postgres',
      format: 'zip',
    });

    const shell = plan.argv[7] as string;
    assert.ok(shell.includes('pg_dumpall'));
    assert.ok(shell.includes('zip -q'));
    assert.equal(plan.filename, 'out.zip');
  });

  it('rejects an unsupported format value-free', () => {
    assert.throws(
      () =>
        planExportDb({
          service: 'db',
          hostPath: '/tmp/out.rar',
          driver: 'mariadb',
          format: 'rar' as never,
        }),
      (error: unknown) => {
        assert.ok(error instanceof JamalSnapshotError);
        assert.match(error.message, /unsupported file format/);
        return true;
      },
    );
  });
});

describe('formatSnapshotPlan', () => {
  it('renders the operation label and command', () => {
    const plan = planSnapshot({ service: 'db', name: 'test', driver: 'mariadb' });
    const output = formatSnapshotPlan(plan);

    assert.match(output, /Operation:/);
    assert.match(output, /Command:/);
    assert.match(output, /docker compose exec -T db/);
  });
});
