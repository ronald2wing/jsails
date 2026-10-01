/**
 * Pages subpath (`jsails/pages`): compiled page loading, Preact server
 * rendering, static site generation, the page renderer seam, and the
 * first-party `pages` plugin.
 *
 * This barrel owns the complete render surface so a consumer can import
 * everything from one subpath without the root entry.
 */

export {
  loadLayoutModule,
  loadPageModule,
  pageCacheKey,
  renderRoute,
  renderStreamResponse,
  preactPageRenderer,
  PageRenderError,
} from './page.js';

export {
  generateStaticSite,
  StaticSiteError,
  type GenerateStaticSiteOptions,
  type GenerateStaticSiteResult,
} from './static-site/index.js';

export type {
  LayoutModule,
  LayoutProps,
  PageComponent,
  PageModule,
  PageProps,
  PageRenderer,
  PageRenderOptions,
  PageStream,
} from '../contracts/render.js';

export { pagesPlugin, pageRendererToken, staticSiteToken } from './plugin.js';

export { pagesPlugin as default } from './plugin.js';
