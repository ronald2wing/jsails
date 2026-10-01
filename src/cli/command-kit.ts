/**
 * Laravel Zero-style command kit: a small signature DSL plus a command factory
 * that gives app commands parsed arguments/options and an interactive prompter,
 * with no new dependency (the prompter is `node:readline/promises`).
 *
 * A signature is the command name followed by zero or more `{...}` tokens:
 *
 *   hello {name} {email?} {--force} {--queue=}
 *
 *   {name}             required argument
 *   {name?}            optional argument (undefined when absent)
 *   {name=default}     optional argument with a default
 *   {--flag}           boolean flag (accepts `--flag` only)
 *   {--opt=}           option requiring a value (`--opt=value` or `--opt value`)
 *   {--opt=default}    option with a default value when absent
 *
 * Arguments must precede options, names are unique across both, and every name
 * matches `[A-Za-z][A-Za-z0-9_-]*`. {@link defineCommand} turns a signature into
 * a {@link CliCommand}-compatible object whose `run` parses the raw tokens and
 * hands the handler `{ arguments, options, rawArgs }` plus a context extended
 * with a {@link Prompter}.
 */

import { createInterface } from 'node:readline/promises';

import {
  COMMAND_NAME_PATTERN,
  type CliCommand,
  type CliCommandContext,
  type CommandAudience,
} from './commands.js';

/** Raised for any invalid signature or argument-token parsing failure. */
export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

/** One positional argument parsed from a `{name}`-style signature token. */
export interface SignatureArgument {
  readonly name: string;
  readonly required: boolean;
  readonly defaultValue: string | undefined;
}

/** One `--flag`/`--opt=`-style option parsed from a signature token. */
export interface SignatureOption {
  readonly name: string;
  /** `true` for `{--opt=}`/`{--opt=default}` (takes a value), `false` for `{--flag}`. */
  readonly takesValue: boolean;
  readonly defaultValue: string | undefined;
}

/** The typed model {@link parseSignature} returns for one signature. */
export interface ParsedSignature {
  readonly name: string;
  readonly arguments: readonly SignatureArgument[];
  readonly options: readonly SignatureOption[];
}

/** The parsed input {@link defineCommand} hands to its handler. */
export interface ParsedCommandInput {
  readonly arguments: Record<string, string | undefined>;
  readonly options: Record<string, string | boolean | undefined>;
  /** The original raw tokens, untouched. */
  readonly rawArgs: readonly string[];
}

/** Interactive prompt helpers built on `node:readline/promises`. */
export interface Prompter {
  text(message: string, options?: { default?: string }): Promise<string>;
  confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
  select<T extends string>(message: string, choices: readonly T[]): Promise<T>;
}

/** The command context plus the injected prompter. */
export type CommandContext = CliCommandContext & { readonly prompter: Prompter };

/** The handler signature for {@link defineCommand}. */
export type CommandRunner = (
  input: ParsedCommandInput,
  ctx: CommandContext,
) => number | void | Promise<number | void>;

/** Options for {@link defineCommand}. */
export interface DefineCommandOptions {
  readonly signature: string;
  readonly summary?: string;
  readonly usage?: string;
  /** Which users this command targets; validated against the two literals. */
  readonly audience?: CommandAudience;
  /** Override the prompter; the caller owns its lifecycle when supplied. */
  readonly prompter?: Prompter;
  readonly run: CommandRunner;
}

/** Names accepted for argument/option tokens. */
const TOKEN_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function assertTokenName(name: string, token: string): void {
  if (!TOKEN_NAME_PATTERN.test(name)) {
    throw new SignatureError(
      `invalid name ${JSON.stringify(name)} in signature token ${JSON.stringify(token)}`,
    );
  }
}

type ParsedToken =
  | { readonly kind: 'argument'; readonly value: SignatureArgument }
  | { readonly kind: 'option'; readonly value: SignatureOption };

/** Parse one `{...}` token into an argument or option, or throw. */
function parseToken(token: string): ParsedToken {
  if (!token.startsWith('{') || !token.endsWith('}')) {
    throw new SignatureError(
      `invalid signature token ${JSON.stringify(token)}: expected {name} or {--flag}`,
    );
  }
  const body = token.slice(1, -1);
  if (body === '') {
    throw new SignatureError(`empty signature token ${JSON.stringify(token)}`);
  }

  if (body.startsWith('--')) {
    const optionBody = body.slice(2);
    if (optionBody === '' || optionBody === '=') {
      throw new SignatureError(`invalid signature token ${JSON.stringify(token)}`);
    }
    const eq = optionBody.indexOf('=');
    if (eq === -1) {
      assertTokenName(optionBody, token);
      return {
        kind: 'option',
        value: { name: optionBody, takesValue: false, defaultValue: undefined },
      };
    }
    const name = optionBody.slice(0, eq);
    assertTokenName(name, token);
    // `{--opt=}` has no default (value required); `{--opt=default}` fills when absent.
    const defaultValue = optionBody.slice(eq + 1) === '' ? undefined : optionBody.slice(eq + 1);
    return { kind: 'option', value: { name, takesValue: true, defaultValue } };
  }

  let argBody = body;
  let required = true;
  if (argBody.endsWith('?')) {
    required = false;
    argBody = argBody.slice(0, -1);
  }
  const eq = argBody.indexOf('=');
  if (eq !== -1) {
    const name = argBody.slice(0, eq);
    assertTokenName(name, token);
    const defaultValue = argBody.slice(eq + 1);
    if (defaultValue === '') {
      throw new SignatureError(`argument ${JSON.stringify(token)} has an empty default`);
    }
    return { kind: 'argument', value: { name, required: false, defaultValue } };
  }
  assertTokenName(argBody, token);
  return { kind: 'argument', value: { name: argBody, required, defaultValue: undefined } };
}

/**
 * Parse a Laravel-style signature into a typed model. Throws a
 * {@link SignatureError} for a malformed signature: an empty/non-string input,
 * an invalid command name, a token outside `{...}`, a duplicate argument/option
 * name, an argument declared after an option, or an invalid name.
 */
export function parseSignature(signature: string): ParsedSignature {
  if (typeof signature !== 'string' || signature.trim() === '') {
    throw new SignatureError('a command signature must be a non-empty string');
  }
  const tokens = signature.trim().split(/\s+/);
  const name = tokens[0] as string;
  if (!COMMAND_NAME_PATTERN.test(name)) {
    throw new SignatureError(`invalid command name ${JSON.stringify(name)} in signature`);
  }

  const argumentsList: SignatureArgument[] = [];
  const optionsList: SignatureOption[] = [];
  const seen = new Set<string>();
  let sawOption = false;

  for (const token of tokens.slice(1)) {
    const parsed = parseToken(token);
    if (parsed.kind === 'option') {
      sawOption = true;
    } else if (sawOption) {
      throw new SignatureError(
        `argument ${JSON.stringify(token)} must precede options in the signature`,
      );
    }
    if (seen.has(parsed.value.name)) {
      throw new SignatureError(`duplicate name "${parsed.value.name}" in signature`);
    }
    seen.add(parsed.value.name);
    if (parsed.kind === 'option') {
      optionsList.push(parsed.value);
    } else {
      argumentsList.push(parsed.value);
    }
  }

  return { name, arguments: argumentsList, options: optionsList };
}

/**
 * Render a parsed signature back into a human-readable usage string:
 * `hello name [email] [--force] [--queue=]`.
 */
export function renderSignatureUsage(signature: ParsedSignature): string {
  const parts: string[] = [signature.name];
  for (const argument of signature.arguments) {
    if (argument.required) {
      parts.push(argument.name);
    } else {
      parts.push(
        `[${argument.name}${argument.defaultValue === undefined ? '' : `=${argument.defaultValue}`}]`,
      );
    }
  }
  for (const option of signature.options) {
    if (!option.takesValue) {
      parts.push(`[--${option.name}]`);
    } else {
      parts.push(
        `[--${option.name}${option.defaultValue === undefined ? '=' : `=${option.defaultValue}`}]`,
      );
    }
  }
  return parts.join(' ');
}

/**
 * Parse raw argument tokens against a parsed signature. Returns typed
 * `arguments`/`options` records and keeps the raw tokens. Unknown options,
 * unknown positional arguments, a missing required argument, or a boolean flag
 * given a value all throw a clear {@link SignatureError}.
 */
function parseInput(signature: ParsedSignature, rawArgs: readonly string[]): ParsedCommandInput {
  const optionByName = new Map(signature.options.map((option) => [option.name, option]));

  const positional: string[] = [];
  const options: Record<string, string | boolean | undefined> = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index] as string;
    if (token === '--') {
      positional.push(...rawArgs.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      const name = body.slice(0, eq);
      const option = optionByName.get(name);
      if (option === undefined) {
        throw new SignatureError(`unknown option "--${name}"`);
      }
      if (!option.takesValue) {
        throw new SignatureError(`flag "--${name}" does not accept a value`);
      }
      options[option.name] = body.slice(eq + 1);
      continue;
    }
    const name = body;
    const option = optionByName.get(name);
    if (option === undefined) {
      throw new SignatureError(`unknown option "--${name}"`);
    }
    if (!option.takesValue) {
      options[option.name] = true;
      continue;
    }
    const next = rawArgs[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new SignatureError(`option "--${name}" requires a value`);
    }
    options[option.name] = next;
    index += 1;
  }

  const arguments_: Record<string, string | undefined> = {};
  signature.arguments.forEach((argument, index) => {
    if (index < positional.length) {
      arguments_[argument.name] = positional[index];
    } else if (argument.required) {
      throw new SignatureError(`missing required argument "${argument.name}"`);
    } else {
      arguments_[argument.name] = argument.defaultValue;
    }
  });
  if (positional.length > signature.arguments.length) {
    const extra = positional
      .slice(signature.arguments.length)
      .map((value) => JSON.stringify(value));
    throw new SignatureError(
      `unexpected argument${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`,
    );
  }

  for (const option of signature.options) {
    if (!(option.name in options)) {
      options[option.name] = option.takesValue ? option.defaultValue : undefined;
    }
  }

  return { arguments: arguments_, options, rawArgs };
}

/**
 * Build a prompter over the given streams (defaults to the process stdio). The
 * returned handle also exposes `close()`, which the command factory calls after
 * the handler settles; callers who inject their own prompter own its lifecycle.
 */
export function createPrompter(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Prompter & { close(): void } {
  const rl = createInterface({ input, output });
  const ask = (query: string): Promise<string> => rl.question(query);
  return {
    async text(message, options = {}) {
      const suffix = options.default === undefined ? '' : ` [${options.default}]`;
      const answer = (await ask(`${message}${suffix}: `)).trim();
      return answer === '' ? (options.default ?? '') : answer;
    },
    async confirm(message, options = {}) {
      const suffix =
        options.default === undefined ? ' [y/N]' : options.default ? ' [Y/n]' : ' [y/N]';
      const answer = (await ask(`${message}${suffix}: `)).trim().toLowerCase();
      if (answer === '') {
        return options.default ?? false;
      }
      return answer === 'y' || answer === 'yes';
    },
    async select<T extends string>(message: string, choices: readonly T[]): Promise<T> {
      if (choices.length === 0) {
        throw new Error('select requires at least one choice');
      }
      const menu = choices.map((choice, index) => `  [${index + 1}] ${choice}`).join('\n');
      const answer = (await ask(`${message}\n${menu}\n> `)).trim();
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1] as T;
      }
      const exact = choices.find((choice) => choice === answer);
      if (exact !== undefined) {
        return exact;
      }
      throw new Error(`invalid selection ${JSON.stringify(answer)}`);
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Build a {@link CliCommand} from a Laravel-style signature. The returned
 * object's `name` comes from the signature, `summary` defaults to the name,
 * and `usage` defaults to the rendered signature. Its `run` parses the raw
 * tokens (throwing a {@link SignatureError} for unknown flags/args) and invokes
 * the handler with `{ arguments, options, rawArgs }` plus a prompter-extended
 * context. The raw tokens stay available on the parsed input.
 */
export function defineCommand(options: DefineCommandOptions): CliCommand {
  if (options === null || typeof options !== 'object') {
    throw new SignatureError('defineCommand expects an options object');
  }
  const signature = parseSignature(options.signature);
  const name = signature.name;
  const summary = options.summary ?? name;
  const usage = options.usage ?? renderSignatureUsage(signature);

  const audience = options.audience;
  if (audience !== undefined && audience !== 'developer' && audience !== 'user') {
    throw new SignatureError('audience must be "developer" or "user"');
  }

  return {
    name,
    summary,
    usage,
    ...(audience === undefined ? {} : { audience }),
    async run(rawArgs, ctx) {
      const input = parseInput(signature, rawArgs);
      const prompter: Prompter = options.prompter ?? createPrompter();
      const ownsPrompter = options.prompter === undefined;
      try {
        return await options.run(input, { ...ctx, prompter });
      } finally {
        // Only close a prompter this command created; an injected prompter is
        // owned by the caller (e.g. a test).
        if (ownsPrompter) {
          (prompter as Prompter & { close(): void }).close();
        }
      }
    },
  };
}
