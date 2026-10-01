// HTTP application and Node server (never opens a port at build/import time).
export {
  createApp,
  readJson,
  CSRF_HEADER,
  DEFAULT_MAX_BODY_BYTES,
  HTTP_METHODS,
  type AppOptions,
} from '../server/app.js';

export { createHttpServer, type HttpServerOptions } from '../server/server-http.js';

export type {
  ApiHandler,
  ApiMethod,
  ApiModule,
  Authorize,
  JsonObject,
  JsonValue,
  RenderPage,
  RequestContext,
  ResolveSession,
  Session,
  SessionStore,
} from '../contracts/http.js';
