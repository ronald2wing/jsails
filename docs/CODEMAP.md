# JSails Codemap

An annotated map of the JSails source tree. Read [architecture](https://jsails.org/docs/architecture)
for the behavior and seams behind these directories. Entries are tagged **[kernel]**
(the inert runtime + seams), **[plugin]** (first-party capability), or **[tooling]**
(CLI/deploy/test orchestration).

Barrel convention: a directory that is a package subpath carries an `index.ts`
barrel; private clusters (`contracts/`, `dev/`, `entry/`, `internal/`, `jsx/`,
`migrations/`, `server/`) do **not** — they are deep-path-imported and marked
"(no public subpath)" below. Nested clusters inside a subpath (for example
`cli/plugins/`, `jamal/production/`, `client/decoding/`) are deep-imported too
and carry no barrel; their siblings with an `index.ts` (`app/config/`,
`server-components/runtime/`, ...) group an internal seam that several modules
import together, so a barrel there is an ownership choice, not a rule.

```text
jsails/
├── src/
│   ├── index.ts                          # [kernel] root entry: re-exports the whole public surface
│   ├── app/                              # [kernel] application runtime
│   │   ├── application.ts                #   createApplication: route discovery + extensions + inert app
│   │   ├── config/                       #   loadAppConfig / validateAppConfig / defineAppConfig (dirs, guards)
│   │   ├── asset-urls.ts                 #   content-hashed asset URL resolver (graceful degradation)
│   │   ├── static-files.ts               #   public/ copy + static serving
│   │   ├── scaffold.ts                   #   writeProjectFiles: validated, rollback-safe file writer
│   │   ├── starter/                      #   createStarterFiles: pure template scaffold generator
│   │   └── plugin.ts                     #   appPlugin / httpAppToken (Hono app service)
│   ├── extensions/                       # [kernel] extension foundation (jsails/extensions)
│   │   ├── extension.ts                  #   runExtensions: ordered setup, requires, HTTP/serve hooks
│   │   ├── plugin-contract.ts            #   definePlugin: extension + deployments/renderer passthrough
│   │   ├── declarative-plugin.ts / contracts.ts
│   │   ├── services.ts                   #   createServiceToken / createServiceRegistry
│   │   ├── interceptors.ts               #   operations/events, before/after interceptors, observers
│   │   └── validation.ts                 #   structural extension-entry validation
│   ├── routing/                          # [kernel] lexical route discovery (no import, no connection)
│   │   ├── routes.ts                     #   discoverRoutes: group stripping, layout chain, route/param classification
│   │   ├── middleware.ts                 #   per-route middleware: types, registry, resolver, chain runner, validator
│   │   └── signed-urls.ts               #   HmacUrlSigner: HMAC-SHA256 signed URLs with expiry, value-free errors
│   ├── server/                           # [kernel] Hono HTTP pipeline (no public subpath; surfaced via entry/http-surface.ts)
│   │   ├── app.ts                        #   createApp: middleware, auth, API/pages dispatch
│   │   ├── server-http.ts                #   createHttpServer (never listens)
│   │   └── api-routes.ts / page-routes.ts / request-pipeline.ts / cache-control.ts / security-headers.ts
│   ├── pages/                            # [kernel] compiled page loading + rendering
│   │   ├── page.ts                       #   loadPageModule, loadLayoutModule, renderRoute (layout fold), renderStreamResponse (progressive streaming), pageCacheKey + opt-in revalidate caching
│   │   └── static-site/                  #   generateStaticSite (static export)
│   ├── contracts/                         # [kernel] shared type contracts (no public subpath): http/render/component
│   ├── environment.ts                     # [kernel] readEnvironment / readDatabaseEnvironment / readValkeyEnvironment
│   ├── entry/                             # [kernel] root-only public surfaces (no subpath): *-surface.ts (http/app/environment/cli/migrations)
│   ├── internal/                          # [kernel] internal shared helpers (no public subpath): awaitable/bytes/cleanup/crypto/errors/html/http/json-safe/responses/trusted-mutation/zod
│   ├── symbols/                           # [kernel] framework-symbols preload (jsails/symbols, jsails/symbols/client)
│   │   ├── framework-symbols.ts           #   FrameworkSymbol mechanism + declaration model (project onto globalThis)
│   │   ├── framework-symbol-catalog-scan.ts       #   scanFrameworkCatalog / deriveFrameworkSymbols (derives the table at build:meta)
│   │   ├── projection.ts                  #   projectFrameworkSymbols + collision/namespace helpers
│   │   ├── install-server.ts              #   installFrameworkSymbols / installProjectSymbols (server preload)
│   │   ├── install-browser.ts             #   installBrowserSymbols (browser-safe projection)
│   │   ├── index.ts                       #   barrel: jsails/symbols (server)
│   │   └── client.ts                      #   barrel: jsails/symbols/client (browser)
│   ├── database/                         # [kernel] data layer
│   │   ├── data-source.ts                #   JsailsDataSource (postgres/mysql/mariadb + sqljs/sqlite)
│   │   ├── model-schema.ts               #   TypeORM metadata -> portable SchemaState (M2M/composite/deferrable aware)
│   │   ├── polymorphic.ts                #   @PolymorphicRelation + loadPolymorphic[Inverse] / resolvePolymorphic*
│   │   ├── relation-metadata.ts           #   resolveRelation / resolveRelationPath (pure, connectionless)
│   │   ├── relation-loader/              #   loadRelation / loadRelations (batch IN-clause: M2O/O2M/O2O/M2M/polymorphic, nested)
│   │   ├── relation-query.ts              #   whereHas/has/exists (portable EXISTS) + relationCount/relationAggregate
│   │   ├── query-expressions.ts           #   F / Q predicate tree / Case-When + applyQ / addCaseSelect
│   │   ├── model-query.ts                 #   query() -> chainable ModelQuery (where/whereHas/has/includes/executors + annotate/in_batches/find_each)
│   │   ├── file-data-source.ts           #   read-only in-memory sqljs source
│   │   ├── entity-subscribers.ts         #   defineEntityHooks / createEntitySubscriber
│   │   ├── attribute-encryption.ts        #   encrypts: transparent field encryption/decryption (AES-256-GCM)
│   │   ├── counter-cache.ts               #   counterCache / touch / autosave / nestedAttributes (hook bridges)
│   │   ├── through-relations.ts            #   resolveThroughRelation + ThroughRelation (has_many :through)
│   │   ├── active-storage.ts              #   hasOneAttached / JsailsAttachment / activeStorageEntities (Disk-backed)
│   │   ├── fixtures.ts                    #   defineFixture / loadFixtures / withRollback / FixtureError
│   │   ├── system-checks.ts               #   createSystemCheckRegistry / defineSystemCheck / SystemCheckError
│   │   ├── factories.ts                  #   defineFactory (entity fixtures)
│   │   ├── schema-editor.ts              #   DDL translation, deferrable-gated driver mapping, preflight
│   │   └── plugin.ts                     #   databasePlugin / databaseToken
│   ├── migrations/                       # [kernel] declarative, desired-state schema reconciliation (no public subpath; surfaced via entry/migrations-surface.ts)
│   │   ├── schema-types.ts               #   Column/Table/Index/Unique/ForeignKey definitions (+ composite PKs/FKs, deferrable)
│   │   ├── schema-validation.ts          #   identifier + scalar-literal validation (isValidIdentifier / assertLiteralMatchesType)
│   │   ├── schema-normalize.ts           #   normalizeX canonicalization (columns/tables/constraints/schema)
│   │   ├── schema-compare.ts             #   canonical *Equal comparators (columnsEqual / schemasEqual / ...)
│   │   ├── autodetector.ts               #   declared-vs-live diff (M2M/join-table aware); requireDestructive gates unsafe ops
│   │   ├── operations.ts                 #   operation types + applyOperations
│   │   ├── reconciler.ts                 #   reconcileDataSource + isOperationDestructive (safe/destructive classification)
│   │   ├── schema-executor.ts            #   executeSchemaPlan (connect/release discipline, applies a plan)
│   │   └── data.ts                       #   defineDataMigration / createDataMigrationRegistry (phase-2 data migrations)
│   ├── ai/                                  # [plugin] provider-neutral AI runtime (jsails/ai)
│   │   ├── index.ts                         #   barrel: re-exports runtime + types + transports
│   │   ├── types.ts                         #   AiMessage / AiTool / AiToolCall / AiRunOptions / AiStreamEvent / AiError
│   │   ├── runtime.ts                       #   createAiRuntime: chat / stream / run (agent tool-calling loop over an AiTransport)
│   │   ├── transport.ts                     #   AiTransport contract + assertValidMessages (provider-neutral seam)
│   │   └── transports.ts                    #   createHttpTransport (fetch-based backend) + createMcpTransport (MCP-client adapter)
│   ├── api/                              # [kernel] browser-safe API building blocks (jsails/api)
│   │   ├── resource.ts                   #   createResourceHandlers over a ResourceStore
│   │   ├── serialization.ts              #   defineSerializer
│   │   ├── validation.ts                 #   schema builders + ValidationError
│   │   ├── pagination.ts                 #   normalized pagination
│   │   ├── filters.ts                    #   parseFilters (search/sort/filter coercion)
│   │   ├── permissions.ts                #   require/and/or/resourcePolicy + createPermissionRegistry
│   │   ├── throttling.ts                 #   throttle (fixed-window 429)
│   │   ├── forms.ts                      #   readForm (bounded form decoding)
│   │   ├── openapi.ts                    #   generateOpenApi (deterministic 3.0 doc)
│   │   ├── router.ts                     #   createResourceRouter (deterministic route manifest)
│   │   └── versioning.ts                 #   resolveApiVersion (URL-then-Accept precedence)
│   ├── diagnostics/                      # [plugin] Telescope-style in-memory recorder (jsails/diagnostics)
│   │   ├── index.ts                       #   barrel: recorder + watchers + plugin
│   │   ├── recorder.ts                    #   InMemoryDiagnosticsRecorder (ring buffer, wrapAsync, pause/resume, prune)
│   │   ├── watchers/index.ts              #   createWatcherRegistry / Watcher / WatcherContext (sealed registry)
│   │   ├── tags.ts                        #   createTagRegistry / TagCallback (derived entry tags)
│   │   ├── filters.ts                     #   applyFilters / DiagnosticsFilters (record-time gate, fail-closed)
│   │   ├── prune.ts                       #   pruneEntries / PruneOptions (time-based eviction with exception floor)
│   │   ├── plugin.ts                      #   diagnosticsPlugin / diagnosticsToken
│   │   └── watchers/
│   │       ├── request.ts                 #   RequestWatcher (signals observer: method/route/status/durationMs/slow)
│   │       ├── query.ts                   #   QueryWatcher (injected onQuery: sql/bindingCount/slow)
│   │       └── exception.ts               #   ExceptionWatcherImpl (capture + dedup: class/file/line/frames/counts)
│   ├── logging/                          # [plugin] record-first structured logging (jsails/logging)
│   │   ├── index.ts                       #   barrel: types + formatters + channels + logger + plugin
│   │   ├── log-types.ts                  #   LogLevel / LogRecord / LogChannel / LogFormatter / Logger
│   │   ├── errors.ts                      #   LoggerError (value-free)
│   │   ├── formatters.ts                  #   jsonFormatter / lineFormatter (never throw)
│   │   ├── channels.ts                    #   consoleChannel / memoryChannel / nullChannel
│   │   ├── logger.ts                      #   RecordLogger (record-first, child context, sinks)
│   │   ├── events.ts                      #   logError event token
│   │   └── plugin.ts                      #   loggerPlugin / loggerToken
│   ├── encryption/                       # [plugin] symmetric AES-256-GCM encryption (jsails/encryption)
│   │   ├── index.ts                       #   barrel: types + error + encrypter + plugin
│   │   ├── encrypter-types.ts            #   Encrypter / EncrypterOptions / EncryptOptions / DecryptOptions
│   │   ├── errors.ts                      #   EncryptionError (value-free)
│   │   ├── encrypter.ts                   #   AesEncrypter (AES-256-GCM, HKDF key, rotation)
│   │   └── plugin.ts                      #   encryptionPlugin / encryptionToken
│   ├── content/                          # [plugin] Markdown/SSG content layer (jsails/content; server-only)
│   │   ├── content-model.ts / discover.ts / render.ts / highlight.ts
│   │   ├── cache.ts / errors.ts / blog.ts / taxonomy.ts / taxonomies.ts
│   │   └── sections.ts / feed.ts / sitemap.ts / versions.ts / index.ts
│   ├── client/                           # [plugin] browser runtime (jsails/client)
│   │   ├── index.ts                      #   startClient (idempotent)
│   │   ├── islands.ts                    #   registerIsland + hydration (WeakMap identity)
│   │   ├── navigation.ts                 #   Turbo soft navigation + morphComponent
│   │   ├── streams.ts                    #   turboStreamMessage + *Stream string builders (no DOM, server-safe)
│   │   ├── native.ts                     #   Hotwire Native path config + nativeApp detection
│   │   ├── native-protocol.ts            #   bridge message envelope + component registry + visit-proposal contract
│   │   ├── path-config-loader.ts         #   path-configuration loader: data/file/server sources + merge
│   │   ├── bindings/                     #   server-component DOM binding layer (controller/rules/uploads/control-values)
│   │   ├── model/                        #   createModel/bindModel: browser-safe projection of server state into @preact/signals (jsails/client/model)
│   │   └── state-decoding.ts             #   state controller: model, update queue, CSRF POST
│   ├── server-components/                # [plugin] signed, stateless HotView components
│   │   ├── component.ts                  #   defineServerComponent / defineAction
│   │   ├── authoring/                    #   friendly surface: defineComponent, localAction/serverAction, defineStyle (lowers onto defineServerComponent)
  │   │   ├── extension.ts                  #   serverComponentsPlugin() extension + render helpers
  │   │   ├── runtime/index.ts               #   update endpoint: signature/CSRF/origin/state machine
  │   │   ├── snapshot.ts                   #   HMAC snapshot signing + parsing
  │   │   ├── protocol.ts                   #   wire markers/constants (shared with client)
  │   │   ├── directives.ts                 #   confirmAttrs/loadingTargetAttrs/showAttrs/textAttrs/sortAttrs/intersectAttrs/refAttrs/ignoreAttrs builders + protocol constants
  │   │   ├── pagination.ts                 #   pagerAttrs: array-page call-attribute maps (reuses Page<T>)
  │   │   ├── url-binding.ts                #   seedFromUrl: query-string seeding for urlBinding fields
  │   │   ├── downloads.ts                  #   download(id) action return + createDownloadReferenceSigner
  │   │   ├── validation-meta.ts            #   extractFieldRules / serializeFieldRules
  │   │   ├── form.ts                       #   defineForm: HotView form objects for components
  │   │   ├── nested.ts                     #   defineNestedComponent / renderNested: child components
  │   │   └── uploads.ts                    #   signed upload references
│   ├── auth/                             # [plugin] Better Auth over MariaDB (jsails/auth)
│   │   ├── plugin.ts                     #   authPlugin: session service + trusted hook routes
│   │   ├── instance.ts                   #   createAuth / resolveSessionFromRequest
│   │   ├── routes.ts                     #   login/logout/device handlers (+ shared helpers)
│   │   ├── registration.ts               #   handleRegister
│   │   ├── password-reset.ts             #   reset + verification handlers + mail senders
│   │   ├── roles.ts                      #   sessionRole / requireRole / adminOnly
│   │   ├── token.ts                      #   authSessionToken / AuthSessionService
│   │   ├── migrations.ts                 #   getAuthMigrations (Better Auth schema)
│   │   ├── cli-client.ts                 #   RFC 8628 device-flow CLI (login/whoami/logout)
│   │   └── csrf.ts                       #   [internal] SessionManager + cookie/CSRF primitives
│   ├── validation/                       # [kernel] composable validation rules (jsails/validation)
│   │   ├── index.ts                      #   barrel: rules + validateFields
│   │   └── rules.ts                      #   required/email/url/min/max/regex/inList/confirmed/when
│   ├── http/                             # [kernel] fetch-based HTTP client (jsails/http)
│   │   ├── index.ts                      #   barrel
│   │   ├── client.ts                     #   FetchHttpClient (injectable fetch, retries, value-free errors)
│   │   └── fake.ts                       #   FakeHttpClientImpl (test stub: respond(handler), no-history delegation)
│   ├── inertia/                           # [kernel] minimal Inertia-style page adapter (jsails/inertia)
│   │   ├── inertia.ts                     #   createInertiaPage / renderInertiaPage / inertiaVersion / resolveInertiaProps / mergeSharedProps / resolveErrorBag / errorsFor
│   │   └── index.ts                       #   barrel
│   ├── admin/                            # [plugin] admin panel (jsails/admin)
│   │   ├── panel.ts                      #   defineAdminPanel (base path/title/auth/resolveSession)
│   │   ├── plugin.ts                     #   adminPlugin: mounts dashboard/search/pages/resources/actions
│   │   ├── document.ts                   #   renderAdminDocument (+ renderAdminDocumentWithTheme) admin HTML document shell
│   │   ├── page.ts                       #   renderAdminPage / layout primitives
│   │   ├── tabs.ts                       #   defineTabs / renderTabs (tabbed form layout)
│   │   ├── wizard.ts                     #   defineWizard / renderWizard (multi-step form)
│   │   ├── relation-manager.ts           #   defineRelationManager / renderRelationManager (related-resource panels)
│   │   ├── relation-actions.ts           #   defineAttachAction / defineDetachAction (M2M attach/detach)
│   │   ├── charts.ts                     #   lineChartSvg / barChartSvg / donutChartSvg / areaChartSvg
│   │   ├── widgets.ts / notices.ts / actions.ts / action-routes.ts / global-search.ts / guards.ts
│   │   ├── routes.ts / list-query.ts / relation-routes.ts / admin-plugin.ts
│   │   ├── resource-routes/              #   resource CRUD HTTP surface
│   │   │   ├── index.ts                  #   registerResourceRoutes (CRUD HTTP surface)
│   │   │   ├── crud.ts                   #   list/create/get/update/delete handlers (+ repeater intent)
│   │   │   ├── list.ts                   #   list page handler (render-list)
│   │   │   └── form.ts                   #   create/edit form handler (render-form)
│   │   └── resource/                     #   resource descriptor model + rendering (public barrel: resource/index.ts)
│   │       ├── index.ts                  #   defineResource / Resource (public descriptor barrel)
│   │       ├── resource-descriptor.ts / columns.ts / fields.ts / field-schemas.ts
│   │       ├── render-list.ts            #   renderListPage / renderTable (list markup)
│   │       ├── render-form.ts            #   renderFormPage / renderForm / renderField (form markup)
│   │       ├── render-shared.ts          #   renderFormattedValue / formatDate (shared cell/value renderers)
│   │       ├── repeater-intent.ts        #   detectRepeaterIntent / applyRepeaterIntent (repeater form intent)
│   │       ├── grouping.ts               #   groupRows / renderGroupedTable
│   │       ├── export.ts                 #   defineExportAction / serializeExport / wireExportAction
│   │       ├── store-resource.ts         #   defineStoreResource (resource backed by a ResourceStore)
│   │       └── error.ts                  #   ResourceError (value-free resource errors)
│   ├── blog/                             # [plugin] first-party blog (jsails/blog)
│   │   ├── plugin.ts / admin-resource.ts  #   blogPlugin / blogAdmin
│   │   └── database-store.ts             #   createDatabaseBlogStore (MariaDB/Postgres/SQLite jsails_blog_post)
│   ├── plugins/                          # [plugin] plugin system (jsails/plugins)
│   │   ├── manifest/index.ts / discovery/index.ts / check.ts / activation.ts / installer.ts
│   │   ├── enablement.ts / state-store.ts / database-state-store.ts / database-state-entity.ts
│   │   ├── archive.ts / provenance.ts / download-capability.ts
│   ├── plugin-tools/                      # [plugin] canonical internal tool modules for plugin authors (jsails/plugin-tools)
│   │   └── index.ts / plugin.ts
│   ├── admin-plugin-manager/             # [plugin] admin-plugin-manager admin plugin (jsails/admin-plugin-manager)
│   │   ├── index.ts / plugin.ts / plugin-data.ts / plugin-list.ts / plugin-manager-responses.ts / plugin-notices.ts / plugin-settings.ts
│   ├── jobs/                             # [plugin] BullMQ jobs
│   │   ├── registry.ts                   #   defineJob / createJobRegistry
│   │   ├── runtime.ts                    #   JobsRuntimeImpl (provider-neutral controller)
│   │   ├── bullmq-adapter.ts             #   BullMQAdapter (default transport)
│   │   ├── runtime-config.ts             #   validateRuntimeConfig + URL resolution
│   │   ├── middleware.ts                 #   composeMiddleware / per-job middleware (worker-side)
│   │   ├── chain.ts                      #   createJobChain / chainMiddleware (sequential, on-success)
│   │   ├── batch.ts                      #   createJobBatch / createBatchMiddleware / InMemoryBatchCoordinator (fan-out + in-process coordinator)
│   │   ├── shared-batch-coordinator.ts    #   SharedBatchCoordinator (multi-process batch progress via CacheStore)
│   │   ├── metrics.ts                    #   InMemoryJobMetrics (completed/failed by name, in-memory)
│   │   ├── metrics-history.ts            #   JobMetricsHistoryImpl (time-stamped snapshot ring)
│   │   ├── tags.ts                       #   normalizeTags / tagFilter (job classification labels)
│   │   ├── events.ts                     #   job lifecycle events: jobPushed/completed/failed/retried
│   │   ├── failed.ts                     #   InMemoryFailedJobStore (ring buffer with retry + age-based retention + tag filter)
│   │   ├── overlap.ts                    #   createOverlapMiddleware (mutex-backed concurrency gate, OVERLAP_OPTION_KEY)
│   │   ├── paused-schedules.ts           #   MemoryPausedScheduleStore / CachePausedScheduleStore (durable schedule pause)
│   │   └── queue.ts / scheduler.ts / connection.ts / plugin.ts
│   ├── broadcast/                        # [plugin] Socket.IO broadcast
│   │   ├── server.ts / socketio-adapter.ts / redis.ts / client.ts / contracts.ts / plugin.ts
│   ├── cache/                            # [plugin] cache + rate limiting + mutex store (jsails/cache)
│   │   ├── store.ts                        #   CacheStore contract + memory/Valkey stores
│   │   ├── limiter.ts                      #   FixedWindowRateLimiter (fixed-window, over CacheStore)
│   │   ├── plugin.ts                       #   cachePlugin / cacheToken
│   │   ├── mutex.ts                        #   MutexStore contract + memory/Valkey mutex stores (atomic acquire)
│   │   ├── mutex-plugin.ts                 #   mutexPlugin / mutexToken
│   │   └── valkey-connection.ts            #   module-internal shared Valkey helpers (NOT exported)
│   ├── mail/                             # [plugin] transport-agnostic mail (jsails/mail)
│   │   └── index.ts / mailer.ts / plugin.ts / transports.ts
│   ├── mcp/                               # [plugin] MCP introspection server (jsails/mcp)
│   │   ├── index.ts / tool.ts             #   defineMcpTool / createMcpToolRegistry / buildJsailsMcpServer
│   │   ├── server.ts                      #   createMcpServer over the official @modelcontextprotocol/server SDK (stdio)
│   │   ├── client.ts                      #   createInProcessMcpClient (in-process, zero-I/O over a local registry)
│   │   └── tools.ts                       #   jsailsMcpTools: describe / inspect_routes / explain_route / schema
│   ├── models/                            # [plugin] one-import Active Record authoring surface (jsails/models)
│   │   └── index.ts
│   ├── filesystem/                       # [plugin] keyed blob-store Disk (jsails/filesystem)
  │   │   ├── index.ts                       #   barrel (public surface)
  │   │   ├── disk.ts / local-disk.ts / memory-disk.ts
  │   │   ├── plugin.ts                      #   filesystemPlugin / filesystemToken
  │   │   ├── variants.ts                    #   defineVariant / DiskVariantResolver
  │   │   └── rich-text.ts                   #   SanitizingRichTextFactory (caller-supplied sanitizer)
│   ├── notifications/                     # [plugin] multi-channel delivery (jsails/notifications)
│   │   ├── index.ts                       #   barrel (public surface)
│   │   ├── notifications.ts               #   NotificationMessage / channels / NotificationsService
│   │   └── plugin.ts                      #   notificationsPlugin (memory/mail channels)
│   ├── i18n/                              # [kernel] dependency-free translator + server-only loader/plugin (jsails/i18n, jsails/i18n/loader, jsails/i18n/server)
│   │   ├── index.ts                       #   barrel (browser-safe public surface)
│   │   ├── translator.ts                  #   MessageTranslator: dot-path lookup, scope/default, interpolation, Intl.PluralRules, exists, onMissing
│   │   ├── localize.ts                    #   createLocalizer: date/time/datetime/number/currency/percent via Intl
│   │   ├── flatten.ts                     #   flattenMessageKeys: dotted keys (plural entries collapse to their parent)
│   │   ├── extract.ts                     #   extractTranslationKeys: acorn-based key scanner for i18n:missing
│   │   ├── loader.ts / catalog-loader.ts  #   (server-only) Loader / FileLoader / ArrayLoader / deepMerge
│   │   ├── plugin.ts                      #   (server-only) i18nPlugin + i18nToken + I18nService
│   │   ├── facade.ts                      #   (server-only) global I18n + bare t/l/choice re-exports
│   │   └── request-locale.ts              #   (server-only) AsyncLocalStorage ambient locale
│   ├── flags/                             # [plugin] feature flags (jsails/flags)
│   │   ├── index.ts                       #   barrel (public surface)
│   │   ├── flags.ts                       #   FeatureStore / MemoryFeatureStore / resolveFeature
│   │   ├── scopes.ts                      #   FlagScope / coverage / everyone / nobody / beforeAfter / shipped / when (A/B testing & gradual rollout primitives)
│   │   ├── plugin.ts                      #   flagsPlugin / flagsToken
│   │   └── database-store.ts              #   JsailsFeatureFlag / DatabaseFeatureFlagStore
│   ├── introspect/                       # [kernel] opt-in runtime introspection endpoint
│   │   ├── index.ts                       #   barrel: sections/providers/route registration
│   │   ├── sections.ts                    #   INTROSPECT_SECTIONS + IntrospectProvider contract
│   │   ├── builtin-providers.ts           #   routes/plugins/components/pipeline/config/health + live providers
│   │   └── route.ts                       #   GET /_jsails/introspect + collision guard
│   ├── sessions/                         # [plugin] database-backed sessions (jsails/sessions)
│   │   └── entity.ts / stores.ts / index.ts
│   ├── signals/                           # [plugin] service-layer signal bus (jsails/signals)
│   │   └── signal-bus.ts / request-signals.ts / plugin.ts / index.ts
│   ├── deploy/                           # [tooling] pure deploy-config generators
│   │   ├── registry.ts / builtin-generators.ts / portable-path.ts
│   │   ├── valkey-config.ts / database-config.ts
│   │   ├── hosting-config.ts / hardening-config.ts / once-config.ts
│   ├── jamal/                            # [tooling] deployment/planning CLI
│   │   ├── command.ts / config.ts / compose.ts / docker.ts
│   │   ├── config.ts                       #   JamalConfig + SSH/health/logging/volume/env breadth (JamalSshConfig, JamalHealthConfig, JamalLoggingConfig, JamalVolumeSpec, JamalEnvEntry, parseVolumeSpec)
│   │   ├── registry.ts                   #   planRegistrySetup / planRegistryRemove / planRegistryLogout (docker login planners)
│   │   ├── prune.ts                      #   planPrune + planPruneExecution (image retention over PruneScope)
│   │   ├── audit.ts                      #   planAudit (security checklist)
│   │   ├── snapshot.ts                   #   planSnapshot / planRestore + planImportDb / planExportDb (db dump/restore + host-file import/export over DbFileFormat)
│   │   ├── describe.ts                   #   describeJamal / planLaunchArgv / planSshArgv (config projection + platform opener + ssh argv)
│   │   ├── app.ts                        #   jamal app (app-container lifecycle over ssh)
│   │   ├── accessory.ts                  #   jamal accessory (backing-service lifecycle over ssh)
│   │   ├── cache-proxy.ts                #   cache-proxy CLI: plan (resolved VCL) + status; read-only
│   │   └── production/                   #   plan/execute/release/command-runner/build/hooks/lock/proxy/cache-proxy/history/transport/accessories
│   │       ├── proxy.ts                    #   ProxyBootOptions / ProxyDeployOptions + proxyBootArgv / proxyDeployArgv (path-prefix routing, TLS staging, metrics port, header/host controls)
│   │       ├── cache-proxy.ts              #   opt-in Varnish cache proxy: config → VCL (default-deny), release steps (write-vcl/boot/health), switch target
│   │       └── hooks.ts                    #   planDevHook over DevHookPhase (pre/post-start, pre/post-import-db)
│   ├── cli/                              # [tooling] CLI command kit + helpers
│   │   ├── index.ts                        #   lazy bootstrap (512 lines): early routing + `runCli`; no heavy deps at import
│   │   ├── dispatch.ts                     #   heavy command imports (TypeORM/BullMQ/Hono/Preact/Vite/Jamal), dynamic-imported only on execute
│   │   ├── command-catalog.ts / command-registry.ts / discovery.ts
│   │   ├── plugins-commands.ts / owned-process-tree.ts
│   │   ├── inspect-commands.ts             #   inspect routes (read-only route manifest)
│   │   ├── describe-commands.ts           #   describe (static definition snapshot: app/routes/plugins/components/schema)
│   │   ├── explain-commands.ts            #   explain (resolve one path against the route manifest + pipeline)
│   │   ├── plugins/resolve.ts              #   plugins resolve (merged enablement, conflict flagging)
│   │   ├── schedule-commands.ts            #   schedules (read-only schedule list CLI)
│   │   ├── seeder-commands.ts / queue-commands.ts / make-commands.ts / convert-commands.ts
│   ├── dev/                              # [tooling] `dev` watch/restart runtime (no public subpath)
│   │   ├── dev-runtime.ts / serve-child.ts #   process management: nodemon watch, serve child lifecycle, restart on change
│   │   ├── plugin.ts                       #   devPlugin: inline-script injection, live-reload SSE endpoint
│   │   ├── live-reload.ts                  #   devReloadScript / liveReloadResponse: EventSource-based auto-reload
│   │   └── readiness.ts                    #   quiescence-window + 2xx probe readiness check (no fixed-sleep polling)
│   ├── testing/                          # [tooling] in-process test harness (jsails/testing)
│   │   ├── app.ts / server-components.ts  #   createTestApp / createComponentTestHarness
│   ├── theme/                            # [kernel] browser-safe CSS custom property token contract (jsails/theme)
│   │   ├── index.ts                       #   barrel: re-exports + module docs
│   │   ├── tokens.ts                      #   coreThemeTokenNames / ThemeTokenMap / ThemeContribution / ThemeTokens / ThemeError / resolveThemeTokens (app-wins-highest) / createThemeTokens / themeTokensToCss
│   │   └── plugin.ts                      #   themeToken / themePlugin (provided under themeToken with PluginDescription.theme contributions)
│   ├── support/                          # [kernel] human-first helper namespaces (jsails/support + jsails/support/server)
│   │   ├── index.ts                       #   browser-safe core barrel: 8 namespaces + domain errors (no node:*, no export *)
│   │   ├── errors.ts                      #   SupportError abstract base (value-free, stable code)
│   │   ├── strings.ts / numbers.ts / time.ts / collections.ts / async.ts / encoding.ts / urls.ts / cryptography.ts
│   │   │                                  #   browser core: Str / Num / Time / Arr / Async / Encoding / Url / Cryptography (+ per-domain errors)
│   │   ├── server.ts                      #   server barrel: re-exports the browser core + the .server.ts addendum
│   │   ├── files.server.ts                #   Files (fs-extra / fast-glob / rimraf) + FilesError
│   │   ├── media.server.ts                #   Media (mime-types / file-type / image-size) + MediaError
│   │   ├── cookie.server.ts               #   Cookie (cookie / set-cookie-parser) + CookieError
│   │   ├── cryptography.server.ts         #   re-exports the SAME Cryptography + server-only hashSync/hmacSync/timingSafeEqual/ServerCryptography
│   │   └── frontmatter.server.ts          #   parseFrontmatter (gray-matter) / serializeError (serialize-error) + FrontmatterError
│   ├── jsx/                              # [kernel] render subpaths (no barrel; each file is its own subpath)
│   │   ├── jsx-runtime.ts / render-to-string.ts   # jsails/jsx-runtime, jsails/render-to-string
│   ├── build/                            # [tooling] jsails/build: the Vite-plugin surface (guards + 'use server' transform)
│   │   ├── clean-bundle-check.ts         #   assertServerOnlyModules + cleanBundlePlugin (generateBundle hook)
│   │   ├── server-directive.ts           #   stripServerDirectives: pure 'use server' function-body rewrite (oxc via rolldown/parseAst)
│   │   ├── server-directive-plugin.ts    #   serverDirectivePlugin (enforce:'pre' transform hook)
│   │   └── index.ts                      #   barrel: bundler guards + re-exported autoloadPlugin/compilerPlugin
│   ├── compiler/                         # [tooling] N1 auto-import compiler + component compiler (surfaced via jsails/build)
│   │   ├── scope-walker.ts               #   collectUnmatchedIdentifiers: two-phase scope resolution (estree via rolldown/utils)
│   │   ├── lexical-walk.ts               #   walkLexicalFiles: lexical file walker (no symlinks)
│   │   ├── project-symbols-scan.ts        #   scanAutoload: N1 auto-import symbol index (app/ + server/ + shared/)
│   │   ├── component-shape.ts             #   component shape analysis: detectComponentShape / planSplit / planCombine
│   │   ├── project-symbols-imports.ts     #   injectAutoloadImports: import-injection transform (RolldownMagicString)
│   │   ├── project-symbols-dts.ts         #   generateProjectSymbolsDts: ambient .jsails/project-symbols.{app,server}.d.ts
│   │   ├── project-symbols-plugin.ts      #   autoloadPlugin (enforce:'pre' buildStart/transform/buildEnd)
│   │   ├── errors.ts                     #   CompilerError/CompilerBuildError: value-free component-compiler errors
│   │   ├── diagnostics.ts                #   DiagnosticBag: collect-then-decide diagnostics + rendered frames
│   │   ├── source-lines.ts               #   lineStartOffsets/offsetToPoint: offset ↔ {line,column} (1-based)
│   │   ├── source-map.ts                 #   SourceMapBuilder: hand-rolled VLQ source maps (line-granular)
│   │   ├── regions.ts                    #   extractRegions: #region model/server/style/view + preamble
│   │   ├── directives.ts                 #   lowerDirective: js-* attribute → render-tool call table
│   │   ├── emit.ts                       #   emitComponent: shape-aware reassembly + directive lowering
│   │   ├── template-ast.ts               #   parseTemplate: Vue-like <template> grammar → TemplateNode[]
│   │   ├── template-lower.ts             #   lowerTemplate: TemplateNode[] → JSX (js-if/js-for/js-* dialects)
│   │   ├── template.ts                   #   lowerTemplateRegion: the U3 seam (leading <template> → JSX)
│   │   ├── resolve-components.ts         #   resolveComponentTags: capitalized tag → app/components import
│   │   ├── sfc.ts                        #   parseSfc: .jsails block scanner (<script>/<template>/<style>/<server>)
│   │   ├── sfc-emit.ts                   #   emitSfc: .jsails blocks → defineComponent module (+ css side-channel)
│   │   ├── compiler-plugin.ts            #   compilerPlugin (.jsails virtual-id dispatch + #region transform; off by default)
│   │   └── index.ts                      #   barrel: re-exports the compiler surface
│
├── templates/
│   ├── starter/                          # web starter (base/admin/blog variants share these)
│   │   ├── pages/                        #   index, about, tasks, login, dashboard, device, blog/*
│   │   ├── components/                   #   task-list.tsx (demo server component)
│   │   ├── ui/                           #   layout, components, counter, styles
│   │   ├── client/main.tsx               #   browser entry (registerIsland + startClient)
│   │   ├── api/  app/  commands/  scripts/  test/  auth/
│   │   ├── jsails.app*.js.template       #   per-variant app config (base/admin/blog)
│   │   ├── jsails.config*.js.template    #   per-variant migration/data-source config
│   │   ├── package.json / tsconfig*.json / vite.config.js / playwright.config.ts / jamal.config.js
│   │   └── .gitignore / .env.auth.example
│   └── starter-cli/                      # CLI-only starter (same framework, no web surface)
│       ├── app/application-command.ts / commands/hello.ts
│       ├── jsails.app.js.template        #   real app config: plugins.use: [] + extension seam
│       └── package.json / tsconfig.json / .gitignore
│
├── scripts/                              # verify-starter, verify-integrations, run-tests harnesses
├── test/                                 # framework unit tests (node --test over dist/)
├── package.json                          # deps + scripts + exports subpaths (see below)
├── tsconfig.json / eslint.config.mjs / .prettierrc.json
└── AGENTS.md / README.md / docs/
```

## Package `exports` subpaths

| Subpath | Module | Notes |
| --- | --- | --- |
| `.` | `src/index.ts` | Root entry; pulls in `reflect-metadata` + TypeORM |
| `./admin` | `src/admin/` | Admin panel building blocks + plugin |
| `./admin-plugin-manager` | `src/admin-plugin-manager/` | Admin plugin-manager UI |
| `./api` | `src/api/` | Browser-safe schemas/serializers/pagination/resources + router + versioning |
| `./app` | `src/app/` | Application runtime assembly (createApplication / createApp) |
| `./auth` | `src/auth/` | Better Auth plugin + account lifecycle + CLI client |
| `./blog` | `src/blog/` | First-party blog plugin/admin/store |
| `./broadcast` | `src/broadcast/` | Socket.IO broadcast server + attachBroadcast |
| `./broadcast/client` | `src/broadcast/client.ts` | Socket.IO browser client |
| `./build` | `src/build/` + `src/compiler/` | Client-bundle server-only guards, the `'use server'` transform, the N1 auto-import compiler, the `#region` component compiler, and the `.jsails` single-file-component compiler |
| `./cache` | `src/cache/` | Cache store + rate limiter + mutex store/plugin |
| `./client` | `src/client/` | Browser island/Turbo/component runtime + Hotwire Native path config |
| `./client/model` | `src/client/model/` | Browser-safe createModel/bindModel projection of server state into signals |
| `./content` | `src/content/` | Server-only Markdown/SSG content layer |
| `./database` | `src/database/` | Active Record data layer + migrations + query seams |
| `./deploy` | `src/deploy/` | Pure deploy-config generators + registry |
| `./diagnostics` | `src/diagnostics/` | In-memory diagnostics recorder + watchers + tag/filter/prune tools + plugin |
| `./encryption` | `src/encryption/` | Symmetric AES-256-GCM encryption with key rotation |
| `./extensions` | `src/extensions/` | ORM/HTTP-free extension foundation + type-only author contracts |
| `./filesystem` | `src/filesystem/` | Disk/FileSystem contracts + plugins |
| `./flags` | `src/flags/` | Feature flags: memory/DB stores, resolveFeature, plugin |
| `./symbols` | `src/symbols/index.ts` | Server framework-symbols preload (installFrameworkSymbols side-effect install) |
| `./symbols/client` | `src/symbols/client.ts` | Browser framework-symbols preload (installBrowserSymbols, browser-safe catalog only) |
| `./http` | `src/http/` | Fetch-based HTTP client with injectable fetch, value-free errors |
| `./i18n` | `src/i18n/` | Dependency-free translator (scope/default/plurals) + `localize()` |
| `./i18n/loader` | `src/i18n/loader.ts` | Server-only catalog loading: `Loader`, `FileLoader`, `ArrayLoader` |
| `./i18n/server` | `src/i18n/facade.ts` | Server-only global `I18n` + bare `t`/`l`/`choice` re-exports |
| `./inertia` | `src/inertia/` | Minimal Inertia-style page adapter (createInertiaPage / renderInertiaPage) |
| `./introspect` | `src/introspect/` | Opt-in runtime introspection endpoint |
| `./jamal` | `src/jamal/` | Deployment/planning CLI (Kamal + Sail in TypeScript) |
| `./jobs` | `src/jobs/` | Provider-neutral job runtime + middleware + chaining + batching + scheduling/overlap + metrics + tags + events + failed-job store |
| `./jsx-runtime` | `src/jsx/jsx-runtime.ts` | Thin Preact JSX runtime re-export |
| `./logging` | `src/logging/` | Record-first structured logging: channels, formatters, plugin |
| `./mail` | `src/mail/` | Mailer seam + transports + plugin |
| `./models` | `src/models/` | One-import Active Record authoring surface |
| `./notifications` | `src/notifications/` | Multi-channel delivery (memory/mail) + plugin |
| `./pages` | `src/pages/` | Compiled page loading + renderRoute + static export |
| `./plugin-tools` | `src/plugin-tools/` | Canonical internal tool modules for plugin authors |
| `./plugins` | `src/plugins/` | Plugin manifest/discovery/enablement/installer/activation |
| `./render-to-string` | `src/jsx/render-to-string.ts` | Preact render-to-string re-export |
| `./routing` | `src/routing/` | Lexical route discovery + middleware + signed URLs |
| `./server-components` | `src/server-components/` | Server-only stateful components with backend actions (defineComponent authoring surface) |
| `./seo` | `src/seo/` | Per-page metadata, head-tag rendering, JSON-LD, sitemap/robots generation |
| `./sessions` | `src/sessions/` | Framework-owned session entity + store |
| `./signals` | `src/signals/` | Service-layer signal bus (observe/emit over shared registry) |
| `./testing` | `src/testing/` | Server-only in-process `createTestApp` |
| `./theme` | `src/theme/` | Browser-safe CSS custom property token contract + plugin |
| `./support` | `src/support/index.ts` | Browser-safe helper namespaces (`Str`/`Num`/`Time`/`Arr`/`Async`/`Encoding`/`Url`/`Cryptography`) |
| `./support/server` | `src/support/server.ts` | Server-only addendum (`Files`/`Media`/`Cookie`/server-`Cryptography`/`parseFrontmatter`/`serializeError`) |
| `./validation` | `src/validation/` | Composable Zod-backed validation rules + validateFields |

## Quick Reference

- **Language/runtime:** TypeScript, ESM only, Node `>=22.13.0`
- **Data:** TypeORM Active Record over MariaDB (default) / Postgres / MySQL / SQLite (via `sqljs`); declarative desired-state schema via `jsails db:push`/`db:diff`
- **HTTP/render:** Hono + Preact SSR; filesystem-routed pages/API; static export
- **Interactivity:** Turbo soft navigation + hydrated Preact islands + signed server components
- **Deploy:** Jamal (`dev`/`deploy` planning + Docker Compose/Kamal execution) + pure deploy generators
- **Build:** `npm run build` · **Typecheck:** `npm run typecheck` · **Lint/format:** `npm run lint` / `npm run format`
- **Verify:** `npm run check` (typecheck + lint + format + full test build); `npm run verify:starter` (opt-in E2E); `npm run verify:integrations` (opt-in, env-gated)
