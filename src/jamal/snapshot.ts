/**
 * Jamal snapshot/restore planners: build `docker compose exec` argv arrays
 * for database dump and restore, modeled after DDEV's `ddev snapshot` and
 * `ddev snapshot restore` subcommands.
 *
 * These are pure planners: they return argv arrays and never run Docker,
 * open a database connection, or write a file. The caller spawns the
 * returned argv against the local Docker Compose project.
 *
 * Supported databases:
 *
 * - **MariaDB / MySQL:** dump via `mariadb-dump` (or `mysqldump` fallback),
 *   restore via `mysql`. The dump is piped through `gzip` for compression.
 * - **PostgreSQL:** dump via `pg_dump`, restore via `pg_restore`. The dump
 *   is piped through `gzip` for compression (DDEV uses `zstd` by default
 *   but `gzip` is universally available).
 */

/** Supported database driver. */
export type SnapshotDriver = 'mariadb' | 'postgres';

/** Input for the snapshot (dump) planner. */
export interface SnapshotInput {
  /** Docker Compose service name of the database container. */
  readonly service: string;
  /**
   * Snapshot name (sanitized into a filename). Defaults to
   * `<service>_<timestamp>` when empty.
   */
  readonly name?: string;
  /** Database driver. */
  readonly driver: SnapshotDriver;
}

/** Input for the snapshot restore planner. */
export interface RestoreInput {
  /** Docker Compose service name of the database container. */
  readonly service: string;
  /** Path of the snapshot file inside the container. */
  readonly snapshotPath: string;
  /** Database driver. */
  readonly driver: SnapshotDriver;
}

/** A planned snapshot or restore command: the argv and a label. */
export interface SnapshotPlan {
  /** Fixed `docker compose exec` argv for the dump. */
  readonly argv: readonly string[];
  /** Human-readable label for the operation. */
  readonly label: string;
  /** The snapshot filename (for display). */
  readonly filename: string;
}

/** Raised for an invalid snapshot/restore invocation. */
export class JamalSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JamalSnapshotError';
  }
}

/**
 * Sanitize a snapshot name into a valid filename: replace characters that
 * are unsafe in filenames with underscores, trim whitespace, and ensure
 * the result is non-empty.
 */
function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'snapshot';
  return sanitized.slice(0, 120);
}

/**
 * Build the `docker compose exec` argv for a database dump.
 *
 * MariaDB: pipes `mariadb-dump --all-databases` (falling back to `mysqldump`)
 * through `gzip` into a file at `/tmp/<name>.sql.gz` inside the container.
 *
 * PostgreSQL: pipes `pg_dumpall` (or `pg_dump` for a single database) through
 * `gzip` into a file at `/tmp/<name>.sql.gz` inside the container.
 *
 * Throws {@link JamalSnapshotError} for an unsupported driver.
 */
export function planSnapshot(input: SnapshotInput): SnapshotPlan {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName =
    input.name !== undefined && input.name !== '' ? sanitizeFilename(input.name) : input.service;
  const filename = `${baseName}_${timestamp}.sql.gz`;
  const targetPath = `/tmp/${filename}`;

  let dumpCmd: string;
  if (input.driver === 'mariadb') {
    // mariadb-dump (MariaDB 10.4+) with mysqldump fallback.
    dumpCmd = `$(command -v mariadb-dump || command -v mysqldump || echo mysqldump) --all-databases`;
  } else if (input.driver === 'postgres') {
    // pg_dumpall for the full cluster; pg_dump for a single DB.
    dumpCmd = 'pg_dumpall';
  } else {
    throw new JamalSnapshotError(
      `unsupported snapshot driver "${String(input.driver)}"; use "mariadb" or "postgres"`,
    );
  }

  const shellCmd = `${dumpCmd} | gzip > ${targetPath}`;

  return {
    argv: ['docker', 'compose', 'exec', '-T', input.service, 'sh', '-c', shellCmd],
    label: `snapshot ${input.service} -> ${filename}`,
    filename,
  };
}

/**
 * Build the `docker compose exec` argv for restoring a database snapshot.
 *
 * MariaDB: pipes the decompressed snapshot through `mysql`.
 * PostgreSQL: pipes the decompressed snapshot through `pg_restore` (custom
 * format) or `psql` (plain SQL via `pg_dumpall`).
 *
 * The snapshot file must already be present at `snapshotPath` inside the
 * container (e.g. copied in or mounted).
 *
 * Throws {@link JamalSnapshotError} for an unsupported driver.
 */
export function planRestore(input: RestoreInput): SnapshotPlan {
  let restoreCmd: string;
  if (input.driver === 'mariadb') {
    restoreCmd = `gunzip < ${input.snapshotPath} | $(command -v mysql || echo mysql)`;
  } else if (input.driver === 'postgres') {
    // pg_dumpall output is plain SQL, restored via psql.
    restoreCmd = `gunzip < ${input.snapshotPath} | $(command -v psql || echo psql)`;
  } else {
    throw new JamalSnapshotError(
      `unsupported restore driver "${String(input.driver)}"; use "mariadb" or "postgres"`,
    );
  }

  const filename = input.snapshotPath.split('/').pop() ?? input.snapshotPath;

  return {
    argv: ['docker', 'compose', 'exec', '-T', input.service, 'sh', '-c', restoreCmd],
    label: `restore ${input.service} <- ${filename}`,
    filename,
  };
}

// ---------------------------------------------------------------------------
// Host-file import/export planners (S11)
// ---------------------------------------------------------------------------

/** File format for a host-side database dump or import. */
export type DbFileFormat = 'sql' | 'sql.gz' | 'mysql' | 'tar' | 'zip';

/** Input for the host-file import planner. */
export interface ImportDbInput {
  /** Docker Compose service name of the database container. */
  readonly service: string;
  /** Path of the file on the host to import. */
  readonly hostPath: string;
  /** Database driver. */
  readonly driver: SnapshotDriver;
  /** File format of the host file. */
  readonly format: DbFileFormat;
}

/** Input for the host-file export planner. */
export interface ExportDbInput {
  /** Docker Compose service name of the database container. */
  readonly service: string;
  /** Path where the host file will be written. */
  readonly hostPath: string;
  /** Database driver. */
  readonly driver: SnapshotDriver;
  /** File format to write. */
  readonly format: DbFileFormat;
}

/** Build the restore command for a given driver. */
function restoreCommand(driver: SnapshotDriver): string {
  if (driver === 'mariadb') {
    return '$(command -v mysql || echo mysql)';
  }
  // postgres
  return '$(command -v psql || echo psql)';
}

/** Build the dump command for a given driver. */
function dumpCommand(driver: SnapshotDriver): string {
  if (driver === 'mariadb') {
    return '$(command -v mariadb-dump || command -v mysqldump || echo mysqldump) --all-databases';
  }
  // postgres
  return 'pg_dumpall';
}

/**
 * Build the decompress-and-restore pipeline for importing a host file
 * into the database container through stdin.
 */
function importPipeline(format: DbFileFormat, driver: SnapshotDriver): string {
  const restore = restoreCommand(driver);
  switch (format) {
    case 'sql':
      return restore;
    case 'sql.gz':
    case 'mysql':
      return `gunzip -c | ${restore}`;
    case 'tar':
      return `tar xOf - | ${restore}`;
    case 'zip':
      return `unzip -p - | ${restore}`;
    default:
      // Should be unreachable; caller validates.
      throw new JamalSnapshotError(`unsupported import file format "${String(format)}"`);
  }
}

/**
 * Build the dump-and-compress pipeline for exporting a database to a host
 * file through stdout.
 */
function exportPipeline(format: DbFileFormat, driver: SnapshotDriver): string {
  const dump = dumpCommand(driver);
  switch (format) {
    case 'sql':
      return dump;
    case 'sql.gz':
    case 'mysql':
      return `${dump} | gzip`;
    case 'tar':
      return `${dump} > /tmp/_jamal_export.sql && tar cf - /tmp/_jamal_export.sql && rm -f /tmp/_jamal_export.sql`;
    case 'zip':
      return `${dump} > /tmp/_jamal_export.sql && zip -q - /tmp/_jamal_export.sql && rm -f /tmp/_jamal_export.sql`;
    default:
      // Should be unreachable; caller validates.
      throw new JamalSnapshotError(`unsupported export file format "${String(format)}"`);
  }
}

/** Assert the driver and format are valid, value-free. */
function assertImportExportDriver(driver: string): driver is SnapshotDriver {
  if (driver !== 'mariadb' && driver !== 'postgres') {
    throw new JamalSnapshotError(`unsupported driver "${driver}"; use "mariadb" or "postgres"`);
  }
  return true;
}

const VALID_DB_FILE_FORMATS: ReadonlySet<string> = new Set([
  'sql',
  'sql.gz',
  'mysql',
  'tar',
  'zip',
]);

/** Assert the format is valid, value-free. */
function assertDbFileFormat(format: string): asserts format is DbFileFormat {
  if (!VALID_DB_FILE_FORMATS.has(format)) {
    throw new JamalSnapshotError(
      `unsupported file format "${format}"; use "sql", "sql.gz", "mysql", "tar", or "zip"`,
    );
  }
}

/**
 * Build the `docker compose exec` argv for importing a host database file
 * into the database container. The host file is piped through stdin by the
 * caller; the planner only emits the container-side command. The planner
 * never reads or writes the host file.
 *
 * Throws {@link JamalSnapshotError} for an unsupported driver or format.
 */
export function planImportDb(input: ImportDbInput): SnapshotPlan {
  assertImportExportDriver(input.driver);
  assertDbFileFormat(input.format);

  const pipeline = importPipeline(input.format, input.driver);
  const filename = input.hostPath.split('/').pop() ?? input.hostPath;

  return {
    argv: ['docker', 'compose', 'exec', '-T', input.service, 'sh', '-c', pipeline],
    label: `import-db ${input.service} <- ${filename}`,
    filename,
  };
}

/**
 * Build the `docker compose exec` argv for exporting a database to a host
 * file. The container writes the export to stdout; the caller pipes it to
 * the host file. The planner never reads or writes the host file.
 *
 * Throws {@link JamalSnapshotError} for an unsupported driver or format.
 */
export function planExportDb(input: ExportDbInput): SnapshotPlan {
  assertImportExportDriver(input.driver);
  assertDbFileFormat(input.format);

  const pipeline = exportPipeline(input.format, input.driver);
  const filename = input.hostPath.split('/').pop() ?? input.hostPath;

  return {
    argv: ['docker', 'compose', 'exec', '-T', input.service, 'sh', '-c', pipeline],
    label: `export-db ${input.service} -> ${filename}`,
    filename,
  };
}

/**
 * Format the snapshot or restore plan as human-readable output.
 */
export function formatSnapshotPlan(plan: SnapshotPlan): string {
  return [`Operation: ${plan.label}`, '', `Command:`, `  ${plan.argv.join(' ')}`].join('\n');
}
