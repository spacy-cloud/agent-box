export * from './network-presets.js';
export {
  templateSchema,
  parseTemplateObject,
  parseSize,
  parseDuration,
  isSafePackageName,
  domainPatternPort,
  TEMPLATE_NAME_RE,
  TOOL_REF_RE,
  DOMAIN_PATTERN_RE,
  ENV_KEY_RE,
  SECRET_REF_RE,
  CACHE_NAME_RE,
  MAX_TEMPLATE_CACHES,
  type TemplateSchemaOutput,
} from './schema.js';
export {
  parseTemplateYaml,
  safeParseTemplateYaml,
  annotateIssuePositions,
  templateInvalidError,
  formatIssueLocation,
  formatPath,
  MAX_TEMPLATE_BYTES,
  type ParseTemplateOptions,
} from './parse.js';
export {
  resolveTemplate,
  mergeTemplateSpecs,
  detectOsFamily,
  defaultIsolation,
  canonicalJson,
  MAX_EXTENDS_DEPTH,
  TEMPLATE_DEFAULTS,
  type ParentTemplate,
  type ResolveOptions,
  type TemplateLookup,
  type TemplateSource,
} from './resolve.js';
export {
  TOOL_PRESETS,
  UV_VERSION,
  listToolPresets,
  parseToolRef,
  renderToolPreset,
  bootstrapStep,
  type RenderedTool,
  type ToolPreset,
} from './presets.js';
export {
  TemplateCatalog,
  builtinTemplatesDir,
  type TemplateCatalogOptions,
  type TemplateProblem,
  type TemplateSummary,
} from './catalog.js';
export {
  validateTemplate,
  assertTemplateValid,
  MIN_DESCRIPTION_LENGTH,
  type TemplateIssue,
  type ValidateOptions,
  type ValidationResult,
} from './validate.js';
export {
  renderTemplateSnapshot,
  templateRisks,
  unifiedDiff,
  type UnifiedDiffOptions,
} from './review.js';
export {
  buildContextOf,
  collectBuildContext,
  dockerfilePathOf,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_ENTRIES,
  MAX_DOCKERFILE_BYTES,
  MAX_LISTED_FILES,
} from './context.js';
export {
  scanProjectMarkers,
  matchMarkers,
  MAX_DETECT_ENTRIES,
  type FoundMarkers,
  type MarkerCandidate,
} from './detect.js';
export { estimateImageBytes, BUILD_SPACE_FACTOR, type ImageSizeEstimate } from './image-size.js';
export {
  PROJECT_TEMPLATE_DIR,
  assertTemplateFileName,
  checkTemplateDir,
  projectTemplatePath,
  userTemplatePath,
  readTemplateFile,
  writeTemplateFile,
  otherSpellingExists,
  type TemplateSaveTarget,
  type WriteTemplateOptions,
} from './save.js';
export {
  freeTemplateName,
  projectTemplateDraft,
  templateNameFromFolder,
  type ProjectDraftInput,
} from './scaffold.js';
