/**
 * Inertia subpath (`jsails/inertia`): minimal Inertia-style page adapter.
 *
 * Constructs validated Inertia page objects, renders them as JSON or HTML
 * (based on the `X-Inertia` request header), computes deterministic version
 * hashes from asset maps, and supports partial reloads, shared props, and
 * error bags. No Inertia client-side router or view library is required — the
 * caller owns frontend component resolution.
 */
export {
  createInertiaPage,
  withFlash,
  renderInertiaPage,
  inertiaVersion,
  resolveInertiaProps,
  mergeSharedProps,
  resolveDeferredProps,
  resolveErrorBag,
  errorsFor,
  type InertiaPage,
  type CreateInertiaPageOptions,
  type RenderInertiaPageOptions,
  type DeferredProp,
} from './inertia.js';
