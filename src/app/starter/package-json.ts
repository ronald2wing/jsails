/**
 * Generated `package.json` rewriting for the starter scaffold.
 *
 * `buildPackageJson` rewrites the bundled `package.json.template` in place: it
 * sets the validated project name and the resolved `jsails` dependency, then
 * merges the extra runtime dependencies and npm scripts. The template is
 * JSON-parsed and re-stringified; nothing is executed.
 */

/**
 * Extra runtime dependencies always merged into `package.json`. The starter's
 * auth and admin stack ships inside the framework, so no direct Better Auth,
 * Kysely, or `mysql2` dependency is added here.
 */
const EXTRA_DEPENDENCIES: Readonly<Record<string, string>> = {};

/** Extra npm scripts always merged into `package.json`. */
export const EXTRA_SCRIPTS: Readonly<Record<string, string>> = {
  'auth:migrate': 'node scripts/auth-migrate.mjs',
  'db:migrate': 'node scripts/db-migrate.mjs',
  'user:create': 'node scripts/create-user.mjs',
};

/**
 * Rewrite the parsed package template: set the validated name and the resolved
 * `jsails` dependency, then merge the extra dependencies and scripts. The
 * template is JSON-parsed and re-stringified; nothing is executed.
 */
export function buildPackageJson(
  template: string,
  name: string,
  dependency: string,
  extraScripts: Readonly<Record<string, string>> = EXTRA_SCRIPTS,
): string {
  const parsed = JSON.parse(template) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  parsed.name = name;
  if (parsed.dependencies !== undefined) {
    parsed.dependencies['jsails'] = dependency;
  }
  parsed.dependencies ??= {};
  Object.assign(parsed.dependencies, EXTRA_DEPENDENCIES);
  parsed.scripts ??= {};
  Object.assign(parsed.scripts, extraScripts);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
