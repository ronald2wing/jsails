import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'out/**',
      'templates/**',
      // The docs site is a separate package with its own tsconfig/toolchain;
      // linting it under the framework's type-checked program would resolve
      // website files against the wrong project. Its own `tsc` is its gate.
      'website/**',
    ],
  },
  // Scope the recommended rules (and the typescript-eslint parser they rely on)
  // to the project's TypeScript/TSX sources only, so plain-JS scripts
  // (scripts/*.mjs) and this config file are never parsed as TypeScript.
  //
  // recommendedTypeChecked runs the parser over the whole TypeScript program
  // (via `projectService`) so rules like no-floating-promises and
  // no-unnecessary-type-assertion have real type information instead of
  // guessing from syntax alone. Stylistic rules are intentionally NOT enabled:
  // Prettier owns formatting.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting: resolve each file's tsconfig through the TS
        // project service (offers lazy config discovery + watch mode support
        // over the legacy `project` globs).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `let` bindings are read inside closures declared before the binding is
      // assigned (a controller may invoke an error/cleanup callback during
      // construction). Converting those to `const` turns an `undefined` read
      // into a TDZ ReferenceError, so the declare-at-top/assign-once idiom is
      // kept as `let`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],

      // A leading `_` marks a deliberately-unused callback argument or local
      // binding (e.g. `(_url, _options) => {}`); honour that convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Server components and the Zod schema builders sit at generic inference
      // boundaries (`z.ZodObject<any>`, `ServerComponentAction<..., any>`) where
      // a precise structural type is impractical; `any` is deliberate (46 sites)
      // and converting it is a type-contract refactor, not a lint cleanup.
      '@typescript-eslint/no-explicit-any': 'off',

      // The portable schema model types entity constructors as `Function`
      // (mirroring TypeORM's `EntityTarget`) and uses `{}` as the "no options"
      // default generic plus reserved empty options interfaces. Both are public
      // API contracts; replacing them changes accepted types.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      // The deliberate `any` at the generic-inference boundaries above flows
      // straight through to these unsafe rules (Zod `.parse()` on
      // `ZodObject<any>`, `Object.getPrototypeOf` prototype guards,
      // `Object.create(null)` prototype-free maps). They re-flag the same `any`
      // that `no-explicit-any` documents as intentional, so enforcing them is
      // the same type-contract refactor the repo already declined.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // `async` is kept for interface conformance (the in-memory session store
      // and the resource/store fixtures implement promise-returning interfaces
      // with synchronous bodies) and for delegating to a promise-returning
      // function without an explicit `await`; neither is a defect.
      '@typescript-eslint/require-await': 'off',

      // A caught error is re-thrown verbatim after teardown and forwarded as a
      // rejection reason across the client runtime, preserving its stack trace,
      // subclass, and fields. Forcing an `Error` wrapper would lose that
      // fidelity, so `throw <unknown>` / `reject(<unknown>)` is intentional; the
      // rule's `allow*` options cannot express it (type narrowing turns the
      // forwarded `unknown` into `{}`).
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',

      // Callbacks (authorize/authenticate hooks, adapter methods, stdout
      // writers) are passed by reference and are plain functions/closures that
      // never rely on `this`; the one detached method is already re-bound via
      // `.call(adapter, ...)`.
      '@typescript-eslint/unbound-method': 'off',

      // `String()` is applied to control values (`JsonValue`) and an entity
      // label (`EntityTarget`) where object arms are out of contract; the
      // stringification is a deliberate coercion, not an accidental
      // `[object Object]` render.
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    // node:test's `test`/`it`/`describe` all return `Promise<void>` and are
    // invoked at module top level without awaiting by design; the rule cannot
    // tell those scheduler calls apart from genuinely un-awaited work inside a
    // test body, so it is disabled for tests only.
    files: ['test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  // Prettier owns formatting; this disables every ESLint rule that would
  // otherwise conflict with (or merely duplicate) Prettier's output. It must
  // stay last so the stylistic rules above cannot be re-enabled.
  eslintConfigPrettier,
);
