---
title: CLI
order: 14
---

# CLI

The `jsails` binary is the single entry point for scaffolding, serving, schema
history, jobs, and deployment planning. It is human-first: it scaffolds and
serves, but decisions with domain impact — applying migrations, destructive
schema changes, deploy configuration — stay explicit human actions.

## Built-in commands

The CLI implements these built-ins:

- `makemigrations` — diff the model metadata against recorded history and write a
  migration file.
- `migrate` — apply migrations, or roll them back with `--down` / `--steps`.
- `showmigrations` — list applied and pending migrations.
- `work` — run a job worker and register schedules.
- `schedule` — register schedules once, then exit.
- `queue` — a read-only queue dashboard.
- `build` — static export into `out/`.
- `serve` — listen until `SIGINT` / `SIGTERM`.
- `create` — scaffold a new project.
- `dev` — compile, watch, and serve.
- `seed` — run registered database seeders.
- `make:<page|api|job|model|command>` — generate a single conventional file.
- `jamal` — deployment planning (see [Jamal](/docs/jamal)).
- `plugins` — discover, check, install, enable, disable, uninstall, and roll back
  plugins.
- `inspect`, `describe`, `explain` — read-only introspection (see
  [Introspection](/docs/introspection)).

`jamal`, `plugins`, `make`, `inspect`, `describe`, and `explain` own their own
subcommands and flags, so they are routed before the shared flag-gating and never
import an app config.

## Config-file defaults

Each command family reads a compiled ESM config module. `.ts` config paths are
rejected — compile first.

| Command family | Default config |
| --- | --- |
| `makemigrations`, `migrate`, `showmigrations` | `jsails.config.js` |
| `work`, `schedule`, `queue` | `jsails.runtime.js` |
| `seed` | `jsails.seed.js` |
| `build`, `serve`, `dev` | `jsails.app.js` |

`build`, `serve`, and `dev` take no host/port/output flags — those come from the
app config. `create` takes no `--config`.

## Scaffolding with `create`

`create <dir>` generates the starter file set and writes it through
`writeProjectFiles`. It refuses an existing non-empty target, a symlink target,
and a non-directory target, and never overwrites an existing file.

```sh
jsails create my-app --install --jsails-dependency "file:/tmp/jsails-0.1.0.tgz"
```

Flags:

- `--name <pkg>` — the package name; defaults to the directory basename.
- `--jsails-dependency <spec>` — a `file:` tarball or path for the generated
  `package.json`.
- `--install` — run `npm install` after writing. Nothing is installed unless this
  is passed; a failed install returns its exit code but keeps the scaffold so you
  can retry.
- `--admin` — add the first-party admin panel.
- `--blog` — add the first-party blog; implies `--admin`.
- `--cli` — scaffold a Laravel-Zero-style CLI-only project with no web surface
  but the same framework and plugin system.
- `--static` — scaffold a pure static-site (SSG) starter with no server plugins.

There is no `--auth` flag: the starter always includes auth. `--cli` is mutually
exclusive with `--admin` / `--blog`.

## Generators — `make:*`

`make:<page|api|job|model|command> <name> [--dir <path>]` generates a single
conventional file using exclusive creation, so an existing file is never
overwritten:

- `pages/<name>.tsx`
- `api/<name>.ts`
- `jobs/<name>.ts`
- `models/<name>.ts`
- `commands/<name>.ts`

Names must match `[A-Za-z][A-Za-z0-9_-]*` and are case-normalized. The templates
follow the starter's own conventions so they compile against a fresh scaffold.
The command performs no writes beyond the single generated file and never imports
application code.

## User-defined commands

An application can add commands without touching the entry point by declaring
them on the app config (`commands: [...]`) or on an extension
(`extensions: [{ ..., commands: [...] }]`). `runCli` dispatches a leading
non-builtin token to the custom path.

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  commands: [
    {
      name: 'hello',
      summary: 'say hello',
      usage: 'hello [name]',
      run(rawArgs, ctx) {
        ctx.stdout(`hello ${rawArgs[0] ?? 'world'}`);
      },
    },
  ],
};
```

A command object is `{ name, summary, usage?, run(rawArgs, ctx) }`. `run` may
return nothing (exit 0), a number in `0..255`, or a promise of either, and
`ctx.stdout` / `ctx.stderr` write lines.

```sh
jsails hello --config jsails.app.js --rawargs
```

- Syntax is `<command> [--config <path>] [raw args]` — the command name comes
  first. The custom path is taken only when `--config` is explicit or the default
  `jsails.app.js` exists.
- Only `--config <value>` / `--config=<value>` **before** a `--` delimiter are
  parsed; every other token — including `--` itself and everything after it — is
  forwarded verbatim and in original order to `run`.
- `jsails <command> --help` prints that command's exact metadata
  (`name - summary`, `Usage: jsails <usage>`) without invoking `setup`, `run`, or
  `createApplication`. Global `jsails --help` imports no app config.
- No application is assembled for a custom command and no extension `setup` runs.
  A config module must still be imported to collect commands, so its own top-level
  code runs — trusted app JS side effects are not prevented.
- The built-in names above (including `jamal` and `plugins`) are always reserved
  and cannot be shadowed.

## Next steps

- [Introspection](/docs/introspection) — `inspect`, `describe`, `explain`, and the
  opt-in runtime endpoint.
