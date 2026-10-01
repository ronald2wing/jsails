/**
 * Jamal subpath (`jsails/jamal`): the single-file config model, pure production
 * deploy planner, on-demand TLS allowlist, registry login/prune/audit/snapshot
 * planners, and execution helpers. Every planner returns a plan object — no
 * Docker, SSH, or file-system writes happen at import.
 */
export {
  DEFAULT_JAMAL_CONFIG_PATH,
  JamalConfigError,
  SecretRef,
  loadJamalConfig,
  normalizeJamalConfig,
  redactJamalConfig,
  secret,
  parseVolumeSpec,
  type JamalConfig,
  type JamalEnvEntry,
  type JamalEnvValue,
  type JamalHealthConfig,
  type JamalLocalConfig,
  type JamalLoggingConfig,
  type JamalProductionConfig,
  type JamalRegistryConfig,
  type JamalServiceConfig,
  type JamalServiceType,
  type JamalSshConfig,
  type JamalVolumeSpec,
  type RedactedJamalConfig,
} from './config.js';

export {
  planProduction,
  containerNameForTag,
  type PlanProductionOptions,
  type ProductionEnvEntry,
  type ProductionPlan,
  type ProductionStep,
  type ProductionStepKind,
  type ProductionVolumeEntry,
} from './production/plan.js';

export {
  createFetchHealthCheck,
  createHooksFilesystem,
  createProcessHookRunner,
  defaultImageTag,
  deployLockDir,
  remoteExecArgv,
  remoteLogsArgv,
  remoteStatusArgv,
  runDeployExecution,
  runRollbackExecution,
  DeployExecuteError,
  RollbackError,
  type DeployExecutionOptions,
  type DeployExecutionResult,
} from './production/execute.js';

export {
  appendDeployEntry,
  deploysHistoryFile,
  emptyDeployHistory,
  readDeployHistory,
  writeDeployHistory,
  DeployHistoryError,
  DEPLOYS_HISTORY_PATH,
  type DeployHistory,
  type DeployHistoryEntry,
} from './production/history.js';

export {
  createOnDemandTlsAllowlist,
  OnDemandTlsAllowlistError,
  type OnDemandTlsAllowlistHandler,
  type OnDemandTlsAllowlistOptions,
} from './on-demand-tls.js';

export {
  planRegistryLogin,
  planRegistrySetup,
  planRegistryRemove,
  planRegistryLogout,
  formatRegistryLoginPlan,
  JamalError,
  type RegistryLoginPlan,
} from './registry.js';

export {
  planPrune,
  planPruneExecution,
  formatPrunePlan,
  JamalPruneError,
  type ImageRef,
  type PruneExecutionInput,
  type PruneExecutionPlan,
  type PruneInput,
  type PrunePlan,
  type PruneScope,
} from './prune.js';

export {
  planAudit,
  formatAuditPlan,
  JamalAuditError,
  type AuditFinding,
  type AuditPlan,
} from './audit.js';

export {
  planSnapshot,
  planRestore,
  planImportDb,
  planExportDb,
  formatSnapshotPlan,
  JamalSnapshotError,
  type DbFileFormat,
  type ExportDbInput,
  type ImportDbInput,
  type RestoreInput,
  type SnapshotDriver,
  type SnapshotInput,
  type SnapshotPlan,
} from './snapshot.js';

// Local-dev breadth: dev-time hook phase planner.
export {
  planDevHook,
  DevHookError,
  type DevHookPhase,
  type DevHookPlan,
} from './production/hooks.js';

// Local-dev breadth: describe/launch/ssh argv planners.
export {
  describeJamal,
  planLaunchArgv,
  planSshArgv,
  DescribeError,
  type DescribeInfo,
} from './describe.js';
