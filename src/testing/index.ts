/**
 * In-process testing entry point (`jsails/testing`).
 *
 * Server-only: importing this subpath pulls in the application runtime (Hono,
 * page rendering, and the app config loader) but is never part of the
 * browser-agnostic root entry. Runtime values are exported here; the types a
 * test author needs to annotate a {@link TestApplication} are re-exported so no
 * root import is required.
 */

export { createTestApp, DEFAULT_TEST_ORIGIN, TEST_ORIGIN_ENV, TestRequestError } from './app.js';

export type { TestAppOptions, TestApplication, TestingLifecycle } from './app.js';

export { createComponentTestHarness } from './server-components.js';

export type {
  ComponentRenderResult,
  ComponentTestHarness,
  ComponentTestHarnessOptions,
  ComponentUpdateOptions,
  ComponentUpdateTestResult,
} from './server-components.js';

export type { Application } from '../app/application.js';
export type { JsailsAppConfig, ResolvedAppConfig } from '../app/config/index.js';
