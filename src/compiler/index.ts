/**
 * Compiler barrel: auto-import injection, generated declarations, and the
 * Vite/Rolldown plugin.
 *
 * Importing this barrel is inert — no filesystem, no build tool, no scanner
 * runs until a function is called or a plugin hook fires.
 */

export { collectUnmatchedIdentifiers } from './scope-walker.js';

export {
  AutoloadInjectionError,
  injectAutoloadImports,
  type AutoloadInjectionResult,
  type InjectedImport,
  type InjectAutoloadImportsOptions,
} from './project-symbols-imports.js';

export {
  generateProjectSymbolsDts,
  type GenerateProjectSymbolsDtsOptions,
  type ProjectSymbolsDtsFiles,
} from './project-symbols-dts.js';

export { generateFrameworkSymbolsDts } from './framework-symbol-dts.js';

export {
  ShimTreeError,
  emitShimTree,
  scanShimModules,
  writeShimTree,
  type ShimModule,
  type ShimTree,
  type ShimTreeErrorCode,
  type ShimTreeOptions,
} from './project-symbols-shims.js';

export { autoloadPlugin, type AutoloadPluginOptions } from './project-symbols-plugin.js';

export { extractRegions, type ComponentRegions, type RegionName } from './regions.js';

export { lowerDirective, type DirectiveLowering, type DirectiveReporter } from './directives.js';

export { parseTemplate, type TemplateNode, type TemplateAttr } from './template-ast.js';

export { lowerTemplate, usesDynamicComponent, type LowerContext } from './template-lower.js';

export { lowerTemplateRegion, type LoweredTemplateRegion } from './template.js';

export {
  emitComponent,
  type EmitOptions,
  type EmitResolveOptions,
  type EmittedComponent,
  type EmitShape,
} from './emit.js';

export {
  collectComponentTags,
  resolveComponentTags,
  type ResolvedComponent,
  type ResolveComponentsOptions,
} from './resolve-components.js';

export {
  extractModel,
  resolveModelFile,
  type ExtractedColumn,
  type ExtractedField,
  type ExtractedModel,
  type ExtractedRelation,
  type FieldDecorator,
  type ModelArg,
  type ModelReporter,
  type RelationKind,
  type ScalarKind,
} from './model-extract.js';

export {
  CLIENT_COMPONENT_EXTENSIONS,
  CONVENTION_DIRS,
  GENERATOR_LAYOUT,
  MAKE_COMMAND_TYPES,
  MODEL_EXTENSIONS,
  N1_DIRECTORIES,
  AUTOLOADABLE_PREFIXES,
  SOURCE_EXTENSIONS,
  camelCase,
  classNameFromFile,
  kebabCase,
  pascalCase,
  probeConventionFile,
  snakeCase,
  toWords,
  type AutoloadContext,
  type GeneratorLayout,
  type MakeCommandType,
} from './conventions.js';

export {
  CompilerBuildError,
  CompilerError,
  type CompilerErrorCode,
  type CompileDiagnostic,
  type DiagnosticSeverity,
  type RelatedDiagnostic,
  type SourcePosition,
  type SourceRange,
} from './errors.js';

export { lineStartOffsets, offsetToPoint } from './source-lines.js';

export { DiagnosticBag, type DiagnosticOptions } from './diagnostics.js';

export {
  compilerPlugin,
  formatDiagnostics,
  surfaceDiagnostics,
  type CompilerPluginOptions,
} from './compiler-plugin.js';

export { parseSfc, type SfcBlocks } from './sfc.js';

export { emitSfc, type EmitSfcOptions, type SfcEmitResult } from './sfc-emit.js';

export { SourceMapBuilder, type ComponentSourceMap } from './source-map.js';
