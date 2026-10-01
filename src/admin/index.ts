/**
 * Admin foundation subpath: the server-only administration surface.
 *
 * `defineAdminPanel` builds a frozen, validated panel descriptor;
 * `adminPlugin` turns it into a first-party `JsailsPlugin` (named `admin`) that
 * mounts trusted, default-deny Hono routes — the dashboard, per-page routes,
 * per-resource CRUD routes, and a 404 catch-all — under the panel's base path.
 * `defineAdminPage` builds a frozen page descriptor (slug, label, `render`,
 * optional `handlePost`); `defineAdminPlugin` builds a plugin descriptor whose
 * `register` contributes pages, resources, and navigation links through a
 * builder; `defineResource` builds a frozen resource descriptor (slug, list
 * columns, form fields, and `list`/`get`/`save` callbacks plus a derived strict
 * Zod schema) that the panel mounts as list/create/edit pages. The shared
 * security/render helpers (`renderAdminDocument`, `adminHtmlResponse`,
 * `adminRedirectResponse`, `assertAdminSession`, `readFormBody`,
 * `assertAdminMutation`) are exported so a page or plugin can assemble its own
 * responses on the same default-deny, origin/CSRF-checked footing. This barrel
 * is the curated public seam; the route registrar stays internal to the
 * subpath.
 */

export {
  defineAdminPanel,
  AdminPanelError,
  DEFAULT_ADMIN_PATH,
  DEFAULT_ADMIN_TITLE,
  DEFAULT_ADMIN_THEME,
  ADMIN_THEMES,
  type AdminPanel,
  type AdminPanelAuthorize,
  type AdminPanelOptions,
  type AdminPanelResolveSession,
  type AdminTheme,
  type AdminThemeCustomization,
  type AdminThemeTokens,
} from './panel.js';

export { adminPlugin } from './plugin.js';

// The `admin` factory (`adminPlugin(panel)`) is the subpath's default export,
// matching every other first-party plugin subpath: `plugins.use` resolves
// `'jsails/admin'` by importing the default export and calling it with the
// panel descriptor passed in the options tuple.
export { adminPlugin as default } from './plugin.js';

export {
  defineAdminPage,
  AdminPageError,
  type AdminPage,
  type AdminPageDefinition,
  type AdminPageRenderContext,
  type AdminPagePostContext,
} from './page.js';

export {
  defineAdminPlugin,
  AdminPluginError,
  type AdminPlugin,
  type AdminPluginDefinition,
  type AdminPluginBuilder,
  type AdminNavigationItem,
} from './admin-plugin.js';

export {
  renderAdminDocument,
  renderAdminDocumentWithTheme,
  adminHtmlResponse,
  adminRedirectResponse,
  type AdminDocumentOptions,
} from './document.js';

export {
  assertAdminSession,
  readFormBody,
  readFormBodyAndFiles,
  assertAdminMutation,
  type ParsedFormBody,
  type UploadedFilePart,
} from './guards.js';

export {
  defineResource,
  ResourceError,
  DEFAULT_MAX_REPEATER_ITEMS,
  type Resource,
  type ResourceAction,
  type ResourceAuthorize,
  type ResourceAuthorizeContext,
  type ResourceColumn,
  type ResourceColumnFormat,
  type ResourceField,
  type ResourceFieldType,
  type ResourceFileDiskContext,
  type ResourceFileDiskResolver,
  type ResourceGetContext,
  type ResourceInfolist,
  type ResourceInfolistEntry,
  type ResourceListContext,
  type ResourceListResult,
  type ResourceRelationResolver,
  type ResourceRepeaterConfig,
  type ResourceRepeaterItemField,
  type ResourceRepeaterItemType,
  type ResourceSaveContext,
  type ResourceSelectOption,
  type ResourceDefinition,
} from './resource.js';

export {
  defineStoreResource,
  StoreResourceError,
  type StoreResourceSpec,
} from './resource/store-resource.js';

// Admin breadth: declarative dashboard widgets, flash notices, resource
// actions, and the cross-resource search renderer. These ORM-free descriptors
// are consumed by `adminPlugin`; exporting them here keeps the subpath a
// complete admin-author surface (the same set the root entry mirrors).
export {
  defineWidget,
  defineProgressWidget,
  defineListWidget,
  defineTrendWidget,
  WidgetError,
  type AdminWidgetContext,
  type AdminWidgetRender,
  type Widget,
  type WidgetDefinition,
  type ProgressWidgetDefinition,
  type ListWidgetDefinition,
  type TrendWidgetDefinition,
} from './widgets.js';

export {
  defineNotice,
  NoticeError,
  ADMIN_ACTION_SUCCESS_CODE,
  ADMIN_ACTION_SUCCESS_NOTICE,
  type Notice,
  type NoticeLevel,
  type NoticeDefinition,
} from './notices.js';

export {
  defineAdminAction,
  defineReplicateAction,
  defineRestoreAction,
  defineImportAction,
  AdminActionError,
  type AdminAction,
  type AdminActionAuthorize,
  type AdminActionAuthorizeContext,
  type AdminActionContext,
  type AdminActionRun,
  type AdminActionDefinition,
} from './actions.js';

export { renderGlobalSearch } from './global-search.js';

// Admin breadth: a small declarative chart surface. `defineChart` builds a
// frozen chart descriptor whose `render` returns trusted SVG markup; the two
// shape helpers produce deterministic, data-independent (label-only) SVG for a
// chart renderer to return directly or compose.
export {
  defineChart,
  ChartError,
  lineChartSvg,
  barChartSvg,
  donutChartSvg,
  areaChartSvg,
  type Chart,
  type ChartContext,
  type ChartDefinition,
  type ChartRender,
  type ChartSeriesPoint,
} from './charts.js';

// Admin breadth: tabbed and wizard form layouts. `defineTabs` groups resource
// fields into named tabs for the create/edit form; `defineWizard` splits the
// form into sequential steps with per-step validation and navigation state.
// Both return frozen descriptors with render helpers that emit Preact markup;
// validation still runs over the full flattened field set.
export {
  defineTabs,
  TabsError,
  collectTabFields,
  renderTabs,
  type Tabs,
  type TabsDefinition,
  type TabDefinition,
  type TabRenderState,
  type RenderTabsOptions,
} from './tabs.js';

export {
  defineWizard,
  WizardError,
  wizardStepValues,
  collectWizardFields,
  renderWizard,
  type Wizard,
  type WizardDefinition,
  type WizardStep,
  type RenderWizardOptions,
} from './wizard.js';

// Admin breadth: relation managers. `defineRelationManager` builds a frozen,
// inert descriptor for inline CRUD over a related resource (the parent resource
// declares `relationManagers`); `renderRelationManager` emits a server-rendered
// table. Route mounting is deliberately NOT part of this surface — consumers
// wire the descriptor into their own pages/routes.
export {
  defineRelationManager,
  renderRelationManager,
  RelationManagerError,
  type RelationManager,
  type RelationManagerDefinition,
  type RelationManagerListContext,
  type RelationManagerCreateContext,
  type RelationManagerDeleteContext,
  type RenderRelationManagerOptions,
} from './relation-manager.js';

// Admin breadth: attach/detach relation actions. Thin `AdminAction` builders
// over a relation manager, for wiring into a related resource's bulk actions.
export {
  defineAttachAction,
  defineDetachAction,
  RelationActionError,
  type AttachActionDefinition,
  type DetachActionDefinition,
} from './relation-actions.js';
