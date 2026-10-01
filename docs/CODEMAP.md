# JSails Codemap

An annotated map of the JSails source tree. Read [ARCHITECTURE.md](./ARCHITECTURE.md)
for the behavior and seams behind these directories. Entries are tagged **[kernel]**
(the inert runtime + seams), **[plugin]** (first-party capability), or **[tooling]**
(CLI/deploy/test orchestration).

```text
jsails/
├── src/
│   ├── index.ts                          # [kernel] root entry: re-exports the whole public surface
│   ├── app/                              # [kernel] application runtime
│   │   ├── application.ts                #   createApplication: route discovery + extensions + inert app
│   │   ├── config.ts                     #   loadAppConfig / validateAppConfig (dirs, guards)
│   │   ├── asset-urls.ts                 #   content-hashed asset URL resolver (graceful degradation)
│   │   ├── static-files.ts               #   public/ copy + static serving
│   │   ├── scaffold.ts                   #   writeProjectFiles: validated, rollback-safe file writer
│   │   ├── starter.ts                    #   createStarterFiles: pure template scaffold generator
│   │   └── inertia.ts                    #   createInertiaPage / renderInertiaPage / inertiaVersion + resolveInertiaProps / mergeSharedProps / resolveErrorBag / errorsFor
│   ├── extensions/                       # [kernel] extension foundation (jsails/extensions)
│   │   ├── extension.ts                  #   runExtensions: ordered setup, requires, HTTP/serve hooks
│   │   ├── plugin.ts                     #   definePlugin: extension + deployments/renderer passthrough
│   │   ├── services.ts                   #   createServiceToken / createServiceRegistry
│   │   ├── interceptors.ts               #   operations/events, before/after interceptors, observers
│   │   └── validation.ts                 #   structural extension-entry validation
│   ├── routing/                          # [kernel] lexical route discovery (no import, no connection)
│   │   ├── routes.ts                     #   discoverRoutes: group stripping, layout chain, route/param classification
│   │   ├── middleware.ts                 #   per-route middleware: types, registry, resolver, chain runner, validator
│   │   └── signed-urls.ts               #   createUrlSigner: HMAC-SHA256 signed URLs with expiry, value-free errors
│   ├── server/                           # [kernel] Hono HTTP pipeline
│   │   ├── app.ts                        #   createApp: middleware, auth, API/pages dispatch
│   │   └── http.ts                       #   createHttpServer (never listens)
│   ├── pages/                            # [kernel] compiled page loading + rendering
│   │   ├── page.ts                       #   loadPageModule, loadLayoutModule, renderRoute (layout fold), renderStreamResponse (progressive streaming), pageCacheKey + opt-in revalidate caching
│   │   └── static-site.ts                #   generateStaticSite (static export)
│   ├── kernel/                            # [kernel] shared type contracts (http/render/preact)
│   ├── env/                              # [kernel] bounded env readers
│   │   └── environment.ts                #   readEnvironment / readDatabaseEnvironment / readValkeyEnvironment
│   ├── database/                         # [kernel] data layer
│   │   ├── data-source.ts                #   JsailsDataSource (postgres/mysql/mariadb + sqljs/sqlite)
│   │   ├── model-schema.ts               #   TypeORM metadata -> portable SchemaState (M2M/composite/deferrable aware)
│   │   ├── polymorphic.ts                #   @PolymorphicRelation + loadPolymorphic[Inverse] / resolvePolymorphic*
│   │   ├── relation-metadata.ts           #   resolveRelation / resolveRelationPath (pure, connectionless)
│   │   ├── relation-loader.ts             #   loadRelation / loadRelations (batch IN-clause: M2O/O2M/O2O/M2M/polymorphic, nested)
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
│   ├── migrations/                       # [kernel] scalar, linear schema history
│   │   ├── schema-state.ts               #   Column/Table/Index/Unique/ForeignKey definitions (+ composite PKs/FKs, deferrable)
│   │   ├── autodetector.ts               #   generateMigration: history-vs-desired diff (M2M/join-table aware)
│   │   ├── operations.ts                 #   operation types + invertOperation
│   │   ├── history.ts                    #   replay/resolve the linear chain
│   │   ├── migrator.ts                   #   migrate / getMigrationStatus / rollbackTo
  │   │   ├── data.ts                       #   defineDataMigration / createDataMigrationRegistry
  │   │   └── squash.ts                     #   squashMigrations (cumulative range replacement)
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
│   │   ├── recorder.ts                    #   createDiagnosticsRecorder (ring buffer, wrapAsync, pause/resume, prune)
│   │   ├── watchers.ts                    #   createWatcherRegistry / Watcher / WatcherContext (sealed registry)
│   │   ├── tags.ts                        #   createTagRegistry / TagCallback (derived entry tags)
│   │   ├── filters.ts                     #   applyFilters / DiagnosticsFilters (record-time gate, fail-closed)
│   │   ├── prune.ts                       #   pruneEntries / PruneOptions (time-based eviction with exception floor)
│   │   ├── plugin.ts                      #   diagnosticsPlugin / diagnosticsToken
│   │   └── watchers/
│   │       ├── request.ts                 #   createRequestWatcher (signals observer: method/route/status/durationMs/slow)
│   │       ├── query.ts                   #   createQueryWatcher (injected onQuery: sql/bindingCount/slow)
│   │       └── exception.ts               #   createExceptionWatcher (capture + dedup: class/file/line/frames/counts)
│   ├── logging/                          # [plugin] record-first structured logging (jsails/logging)
│   │   ├── index.ts                       #   barrel: types + formatters + channels + logger + plugin
│   │   ├── types.ts                       #   LogLevel / LogRecord / LogChannel / LogFormatter / Logger
│   │   ├── errors.ts                      #   LoggerError (value-free)
│   │   ├── formatters.ts                  #   jsonFormatter / lineFormatter (never throw)
│   │   ├── channels.ts                    #   consoleChannel / memoryChannel / nullChannel
│   │   ├── logger.ts                      #   createLogger (record-first, child context, sinks)
│   │   ├── events.ts                      #   logError event token
│   │   └── plugin.ts                      #   loggerPlugin / loggerToken
│   ├── encryption/                       # [plugin] symmetric AES-256-GCM encryption (jsails/encryption)
│   │   ├── index.ts                       #   barrel: types + error + encrypter + plugin
│   │   ├── types.ts                       #   Encrypter / EncrypterOptions / EncryptOptions / DecryptOptions
│   │   ├── errors.ts                      #   EncryptionError (value-free)
│   │   ├── encrypter.ts                   #   createEncrypter (AES-256-GCM, HKDF key, rotation)
│   │   └── plugin.ts                      #   encryptionPlugin / encryptionToken
│   ├── client/                           # [plugin] browser runtime (jsails/client)
│   │   ├── index.ts                      #   startClient (idempotent)
│   │   ├── islands.ts                    #   registerIsland + hydration (WeakMap identity)
│   │   ├── navigation.ts                 #   Turbo soft navigation + morphComponent
│   │   ├── streams.ts                    #   turboStreamMessage + *Stream string builders (no DOM, server-safe)
│   │   ├── native.ts                     #   Hotwire Native path config + nativeApp detection
│   │   ├── native-protocol.ts            #   bridge message envelope + component registry + visit-proposal contract
│   │   ├── path-config-loader.ts         #   path-configuration loader: data/file/server sources + merge
│   │   ├── component-bindings.ts         #   server-component DOM binding layer
│   │   └── state-decoding.ts             #   state controller: model, update queue, CSRF POST
│   ├── server-components/                # [plugin] signed, stateless Livewire-style components
│   │   ├── component.ts                  #   defineServerComponent / defineAction
  │   │   ├── extension.ts                  #   serverComponentsPlugin() extension + render helpers
  │   │   ├── runtime.ts                    #   update endpoint: signature/CSRF/origin/state machine
  │   │   ├── snapshot.ts                   #   HMAC snapshot signing + parsing
  │   │   ├── protocol.ts                   #   wire markers/constants (shared with client)
  │   │   ├── directives.ts                 #   confirmAttrs/loadingTargetAttrs/showAttrs/textAttrs/sortAttrs/intersectAttrs/refAttrs/ignoreAttrs builders + protocol constants
  │   │   ├── pagination.ts                 #   pagerAttrs: array-page call-attribute maps (reuses Page<T>)
  │   │   ├── url-binding.ts                #   seedFromUrl: query-string seeding for urlBinding fields
  │   │   ├── downloads.ts                  #   download(id) action return + createDownloadReferenceSigner
  │   │   ├── validation-meta.ts            #   extractFieldRules / serializeFieldRules
  │   │   ├── form.ts                       #   defineForm: Livewire-style form objects for components
  │   │   ├── nested.ts                     #   defineNestedComponent / renderNested: child components
  │   │   └── uploads.ts                    #   signed upload references
│   ├── auth/                             # [plugin] Better Auth over MariaDB (jsails/auth)
│   │   ├── plugin.ts                     #   authPlugin: session service + trusted hook routes
│   │   ├── better-auth.ts                #   createAuth / resolveSessionFromRequest
│   │   ├── routes.ts                     #   login/logout/device handlers (+ shared helpers)
│   │   ├── registration.ts               #   handleRegister
│   │   ├── password-reset.ts             #   reset + verification handlers + mail senders
│   │   ├── roles.ts                      #   sessionRole / requireRole / adminOnly
│   │   ├── token.ts                      #   authSessionToken / AuthSessionService
│   │   ├── migrations.ts                 #   getAuthMigrations (Better Auth schema)
│   │   ├── cli-client.ts                 #   RFC 8628 device-flow CLI (login/whoami/logout)
│   │   ├── password.ts                   #   [internal] scrypt hash/verify (self-describing, bounded)
│   │   └── csrf.ts                       #   [internal] SessionManager + cookie/CSRF primitives
│   ├── validation/                       # [kernel] composable validation rules (jsails/validation)
│   │   ├── index.ts                      #   barrel: rules + validateFields
│   │   └── rules.ts                      #   required/email/url/min/max/regex/inList/confirmed/when
│   ├── http/                             # [kernel] fetch-based HTTP client (jsails/http)
│   │   ├── index.ts                      #   barrel
│   │   ├── client.ts                     #   createHttpClient (injectable fetch, retries, value-free errors)
│   │   └── fake.ts                       #   createFakeHttp (test stub: respond(handler), no-history delegation)
│   ├── admin/                            # [plugin] admin panel (jsails/admin)
│   │   ├── panel.ts                      #   defineAdminPanel (base path/title/auth/resolveSession)
│   │   ├── plugin.ts                     #   adminPlugin: mounts dashboard/search/pages/resources/actions
│   │   ├── resource.ts                   #   defineResource (list columns + form fields)
│   │   ├── tabs.ts                       #   defineTabs / renderTabs (tabbed form layout)
│   │   ├── wizard.ts                     #   defineWizard / renderWizard (multi-step form)
│   │   ├── relation-manager.ts           #   defineRelationManager / renderRelationManager (related-resource panels)
│   │   ├── relation-actions.ts           #   defineAttachAction / defineDetachAction (M2M attach/detach)
│   │   ├── charts.ts                     #   lineChartSvg / barChartSvg / donutChartSvg / areaChartSvg
│   │   ├── routes.ts / resource-routes.ts / action-routes.ts / list-query.ts
│   │   ├── resource/
│   │   │   ├── schema.ts / render.ts     #   resource descriptor + list/form markup
│   │   │   ├── grouping.ts               #   groupRows / renderGroupedTable
│   │   │   └── export.ts                 #   defineExportAction / serializeExport / wireExportAction
│   │   └── widgets.ts / notices.ts / actions.ts / global-search.ts / page.ts / admin-plugin.ts / helpers.ts
│   ├── blog/                             # [plugin] first-party blog (jsails/blog)
│   │   ├── plugin.ts / admin.ts          #   blogPlugin / blogAdmin
│   │   └── database-store.ts             #   createDatabaseBlogStore (MariaDB/Postgres/SQLite jsails_blog_post)
│   ├── plugins/                          # [plugin] plugin system (jsails/plugins)
│   │   ├── manifest.ts / discovery.ts / check.ts / activation.ts / installer.ts
│   │   ├── enablement.ts / state-store.ts / database-state-store.ts / database-state-entity.ts
│   │   ├── archive.ts / provenance.ts / download-capability.ts
│   ├── plugin-manager/                   # [plugin] plugin-manager admin plugin (jsails/plugin-manager)
│   │   ├── index.ts / plugin.ts / pages.ts
│   ├── jobs/                             # [plugin] BullMQ jobs
│   │   ├── registry.ts                   #   defineJob / createJobRegistry
│   │   ├── runtime.ts                    #   createJobsRuntime (provider-neutral controller)
│   │   ├── bullmq-adapter.ts             #   createBullMQAdapter (default transport)
│   │   ├── runtime-config.ts             #   validateRuntimeConfig + URL resolution
│   │   ├── middleware.ts                 #   composeMiddleware / per-job middleware (worker-side)
│   │   ├── chain.ts                      #   createJobChain / chainMiddleware (sequential, on-success)
│   │   ├── batch.ts                      #   createJobBatch / createBatchMiddleware (fan-out + in-process coordinator)
│   │   ├── shared-batch-coordinator.ts    #   createSharedBatchCoordinator (multi-process batch progress via CacheStore)
│   │   ├── metrics.ts                    #   createJobMetrics (completed/failed by name, in-memory)
│   │   ├── metrics-history.ts            #   createJobMetricsHistory (time-stamped snapshot ring)
│   │   ├── tags.ts                       #   normalizeTags / tagFilter (job classification labels)
│   │   ├── events.ts                     #   job lifecycle events: jobPushed/completed/failed/retried
│   │   ├── failed.ts                     #   createFailedJobStore (ring buffer with retry + age-based retention + tag filter)
│   │   ├── overlap.ts                    #   createOverlapMiddleware (mutex-backed concurrency gate, OVERLAP_OPTION_KEY)
│   │   ├── paused-schedules.ts           #   createMemoryPausedScheduleStore / createCachePausedScheduleStore (durable schedule pause)
│   │   └── queue.ts / scheduler.ts / connection.ts / plugin.ts
│   ├── broadcast/                        # [plugin] Socket.IO broadcast
│   │   ├── server.ts / socketio-adapter.ts / redis.ts / client.ts / contracts.ts / plugin.ts
│   ├── cache/                            # [plugin] cache + rate limiting + mutex store (jsails/cache)
│   │   ├── store.ts                        #   CacheStore contract + memory/Valkey stores
│   │   ├── limiter.ts                      #   createRateLimiter (fixed-window, over CacheStore)
│   │   ├── plugin.ts                       #   cachePlugin / cacheToken
│   │   ├── mutex.ts                        #   MutexStore contract + memory/Valkey mutex stores (atomic acquire)
│   │   ├── mutex-plugin.ts                 #   mutexPlugin / mutexToken
│   │   └── valkey-connection.ts            #   module-internal shared Valkey helpers (NOT exported)
│   ├── mail/                             # [plugin] transport-agnostic mail (jsails/mail)
│   ├── filesystem/                       # [plugin] keyed blob-store Disk (jsails/filesystem)
  │   │   ├── index.ts                       #   barrel (public surface)
  │   │   ├── disk.ts / local-disk.ts / memory-disk.ts
  │   │   ├── plugin.ts                      #   filesystemPlugin / filesystemToken
  │   │   ├── variants.ts                    #   defineVariant / createVariantResolver
  │   │   └── rich-text.ts                   #   createRichText (caller-supplied sanitizer)
│   ├── notifications/                     # [plugin] multi-channel delivery (jsails/notifications)
│   │   ├── index.ts                       #   barrel (public surface)
│   │   ├── notifications.ts               #   NotificationMessage / channels / NotificationsService
│   │   └── plugin.ts                      #   notificationsPlugin (memory/mail channels)
│   ├── i18n/                              # [kernel] dependency-free translator (jsails/i18n)
│   │   ├── index.ts                       #   barrel (public surface)
│   │   └── translator.ts                  #   createTranslator: dot-path lookup, interpolation, Intl.PluralRules
│   ├── flags/                             # [plugin] feature flags (jsails/flags)
│   │   ├── index.ts                       #   barrel (public surface)
│   │   ├── flags.ts                       #   FeatureStore / createMemoryFeatureStore / resolveFeature
│   │   ├── plugin.ts                      #   flagsPlugin / flagsToken
│   │   └── database-store.ts              #   JsailsFeatureFlag / createDatabaseFeatureFlagStore
│   ├── introspect/                       # [kernel] opt-in runtime introspection endpoint
│   │   ├── index.ts                       #   barrel: sections/providers/route registration
│   │   ├── sections.ts                    #   INTROSPECT_SECTIONS + IntrospectProvider contract
│   │   ├── builtin-providers.ts           #   routes/plugins/components/pipeline/config/health + live providers
│   │   └── route.ts                       #   GET /_jsails/introspect + collision guard
│   ├── sessions/                         # [plugin] database-backed sessions (jsails/sessions)
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
│   │   └── production/                   #   plan/execute/release/command-runner/build/hooks/lock/proxy/history/transport/accessories
│   │       ├── proxy.ts                    #   ProxyBootOptions / ProxyDeployOptions + proxyBootArgv / proxyDeployArgv (path-prefix routing, TLS staging, metrics port, header/host controls)
│   │       └── hooks.ts                    #   planDevHook over DevHookPhase (pre/post-start, pre/post-import-db)
│   ├── cli/                              # [tooling] CLI command kit + helpers
│   │   ├── cli.ts                          #   lazy bootstrap (512 lines): early routing + `runCli`; no heavy deps at import
│   │   ├── dispatch.ts                     #   heavy command imports (TypeORM/BullMQ/Hono/Preact/Vite/Jamal), dynamic-imported only on execute
│   │   ├── command-contribution.ts         #   buildCommandContributionIndex (pure, validated index over PluginDescription.commands; phase 1 foundation)
│   │   ├── command-kit.ts / commands.ts / discovery.ts
│   │   ├── plugins-command.ts / owned-process-tree.ts
│   │   ├── inspect-commands.ts             #   inspect routes (read-only route manifest)
│   │   ├── describe-command.ts             #   describe (static definition snapshot: app/routes/plugins/components/schema)
│   │   ├── explain-command.ts              #   explain (resolve one path against the route manifest + pipeline)
│   │   ├── plugins/resolve.ts              #   plugins resolve (merged enablement, conflict flagging)
│   │   ├── schedule-commands.ts            #   schedules (read-only schedule list CLI)
│   │   ├── seeder-commands.ts / queue-commands.ts / make-commands.ts
│   ├── dev/                              # [tooling] `dev` watch/restart runtime
│   ├── testing/                          # [tooling] in-process test harness (jsails/testing)
│   │   ├── app.ts / server-components.ts  #   createTestApp / createComponentTestHarness
│   ├── theme/                            # [kernel] browser-safe CSS custom property token contract (jsails/theme)
│   │   ├── index.ts                       #   barrel: re-exports + module docs
│   │   ├── tokens.ts                      #   coreThemeTokenNames / ThemeTokenMap / ThemeContribution / ThemeTokens / ThemeError / resolveThemeTokens (app-wins-highest) / createThemeTokens / themeTokensToCss
│   │   └── plugin.ts                      #   themeToken / themePlugin (provided under themeToken with PluginDescription.theme contributions)
│   ├── jsx/                              # [kernel] render subpaths
│   │   ├── jsx-runtime.ts / render-to-string.ts   # jsails/jsx-runtime, jsails/render-to-string
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
│       ├── jsails.app.js.template        #   real app config: plugins.enabled: [] + extension seam
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
| `./api` | `src/api/` | Browser-safe schemas/serializers/pagination/resources + router + versioning |
| `./auth` | `src/auth/` | Better Auth plugin + account lifecycle + CLI client |
| `./blog` | `src/blog/` | First-party blog plugin/admin/store |
| `./broadcast/client` | `src/broadcast/client.ts` | Socket.IO browser client |
| `./cache` | `src/cache/` | Cache store + rate limiter + mutex store/plugin |
| `./client` | `src/client/` | Browser island/Turbo/component runtime + Hotwire Native path config |
| `./diagnostics` | `src/diagnostics/` | In-memory diagnostics recorder + watchers + tag/filter/prune tools + plugin |
| `./encryption` | `src/encryption/` | Symmetric AES-256-GCM encryption with key rotation |
| `./extensions` | `src/extensions/` | ORM/HTTP-free extension foundation + type-only author contracts |
| `./filesystem` | `src/filesystem/` | Disk/FileSystem contracts + plugins |
| `./flags` | `src/flags/` | Feature flags: memory/DB stores, resolveFeature, plugin |
| `./http` | `src/http/` | Fetch-based HTTP client with injectable fetch, value-free errors |
| `./i18n` | `src/i18n/` | Dependency-free message translator with pluralization |
| `./logging` | `src/logging/` | Record-first structured logging: channels, formatters, plugin |
| `./jobs` | `src/jobs/` | Provider-neutral job runtime + middleware + chaining + batching + scheduling/overlap + metrics + tags + events + failed-job store |
| `./jsx-runtime` | `src/jsx/jsx-runtime.ts` | Thin Preact JSX runtime re-export |
| `./mail` | `src/mail/` | Mailer seam + transports + plugin |
| `./notifications` | `src/notifications/` | Multi-channel delivery (memory/mail) + plugin |
| `./plugin-manager` | `src/plugin-manager/` | Admin plugin-manager UI |
| `./plugins` | `src/plugins/` | Plugin manifest/discovery/enablement/installer/activation |
| `./render-to-string` | `src/jsx/render-to-string.ts` | Preact render-to-string re-export |
| `./server-components` | `src/server-components/` | Server-only stateful components with backend actions |
| `./sessions` | `src/sessions/` | Framework-owned session entity + store |
| `./testing` | `src/testing/` | Server-only in-process `createTestApp` |
| `./theme` | `src/theme/` | Browser-safe CSS custom property token contract + plugin |
| `./validation` | `src/validation/` | Composable Zod-backed validation rules + validateFields |

## Quick Reference

- **Language/runtime:** TypeScript, ESM only, Node `^20.19.0 || ^22.13.0 || >=24.11.0`
- **Data:** TypeORM Active Record over MariaDB (default) / Postgres / MySQL / SQLite (via `sqljs`); scalar schema history via `makemigrations`/`migrate`
- **HTTP/render:** Hono + Preact SSR; filesystem-routed pages/API; static export
- **Interactivity:** Turbo soft navigation + hydrated Preact islands + signed server components
- **Deploy:** Jamal (`dev`/`deploy` planning + Docker Compose/Kamal execution) + pure deploy generators
- **Build:** `npm run build` · **Typecheck:** `npm run typecheck` · **Lint/format:** `npm run lint` / `npm run format`
- **Verify:** `npm run check` (typecheck + lint + format + full test build); `npm run verify:starter` (opt-in E2E); `npm run verify:integrations` (opt-in, env-gated)
