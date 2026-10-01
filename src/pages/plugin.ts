/**
 * First-party `pages` plugin: provides the default page renderer and static-site
 * generator under typed service tokens so the core pipeline can resolve them
 * from the registry after extensions run.
 *
 * `pagesPlugin()` builds a {@link JsailsPlugin} named `pages` whose `setup`
 * provides {@link preactPageRenderer} under {@link pageRendererToken} and
 * {@link generateStaticSite} under {@link staticSiteToken}.
 *
 * Construction is inert: nothing is read from disk and no connection is opened
 * until the renderer or generator is actually invoked. The returned plugin
 * carries no cleanup — the renderer is stateless and the generator writes the
 * static site through a pipeline that owns its own teardown.
 */

import { definePlugin, type JsailsPlugin } from '../extensions/plugin-contract.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

import type { PageRenderer } from '../contracts/render.js';
import { preactPageRenderer } from './page.js';
import { generateStaticSite } from './static-site/index.js';
import type { GenerateStaticSiteOptions, GenerateStaticSiteResult } from './static-site/index.js';

/**
 * Opaque token for the default {@link PageRenderer}. Defined once here and
 * shared by the provider (`pagesPlugin`) and the core pipeline (which resolves
 * it to render pages in `buildApp` and during static export in `build`).
 */
export const pageRendererToken: ServiceToken<PageRenderer> =
  createServiceToken<PageRenderer>('page-renderer');

/**
 * Opaque token for the static-site generator. Defined once here and shared
 * by the provider (`pagesPlugin`) and the core pipeline (which resolves it
 * to drive `Application.build`).
 */
export const staticSiteToken: ServiceToken<
  (options: GenerateStaticSiteOptions) => Promise<GenerateStaticSiteResult>
> =
  createServiceToken<(options: GenerateStaticSiteOptions) => Promise<GenerateStaticSiteResult>>(
    'static-site-generator',
  );

/**
 * Build the first-party `pages` plugin. The returned plugin is inert at
 * construction and opens no connection.
 */
export function pagesPlugin(): JsailsPlugin {
  return definePlugin({
    name: 'pages',
    setup({ services }) {
      services.provide(pageRendererToken, preactPageRenderer);
      services.provide(staticSiteToken, generateStaticSite);
    },
  });
}
