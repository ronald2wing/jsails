// User-defined CLI commands: pure registry, structural config collection, and
// the signature-based command authoring surface.
export {
  createCliCommandRegistry,
  collectConfigCommands,
  CliCommandError,
  type CliCommand,
  type CliCommandContext,
  type CliCommandErrorCode,
  type CliCommandMetadata,
  type CliCommandRegistry,
  type CliCommandRegistryOptions,
  type CommandAudience,
} from '../cli/command-registry.js';

export {
  createPrompter,
  defineCommand,
  parseSignature,
  renderSignatureUsage,
  SignatureError,
  type CommandContext,
  type CommandRunner,
  type DefineCommandOptions,
  type ParsedCommandInput,
  type ParsedSignature,
  type Prompter,
  type SignatureArgument,
  type SignatureOption,
} from '../cli/signature-commands.js';
