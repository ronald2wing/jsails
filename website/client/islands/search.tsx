/**
 * Client-side search island for the docs site.
 *
 * A ⌘K command palette: a compact trigger button in the header opens a modal
 * with a styled input, keyboard navigation, and Pagefind-backed results. The
 * Pagefind script is loaded via `<script src="/pagefind/pagefind.js" defer>` in
 * the document `<head>`, so `window.Pagefind` is available by hydration time.
 *
 * Navigation uses ordinary `<a href>` — Turbo Drive owns soft navigation.
 *
 * This island also owns two global, page-level enhancements that have no other
 * home: the copy affordance on Shiki code blocks, and the on-this-page TOC
 * scroll-spy. Shiki emits a plain `<pre class="shiki">` with no chrome markup,
 * so the island injects a `<button class="code-copy">` into each block and wires
 * the clipboard through a delegated click handler. Keeping both here avoids
 * extra islands and script tags, since search already runs on every page.
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

/** Minimal Pagefind types (Pagefind's npm package ships no TS declarations). */
interface PagefindResult {
  url: string;
  excerpt: string;
  meta: Record<string, string>;
}

interface PagefindSearchResponse {
  results: Array<{ id: string; data(): Promise<PagefindResult> }>;
}

interface PagefindInstance {
  search(query: string): Promise<PagefindSearchResponse>;
}

declare global {
  interface Window {
    Pagefind?: PagefindInstance;
  }
}

const RESULT_LIMIT = 8;
const DEBOUNCE_MS = 180;
const COPY_RESET_MS = 1400;

/** Strip HTML tags from a snippet string. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Injects the `.code-copy` button into every code block that lacks one.
 *
 * Idempotent: an already-instrumented block is skipped, so it is safe to call
 * both on first hydration and on every Turbo visit without duplicating chrome.
 */
function injectCopyButtons(): void {
  const blocks = document.querySelectorAll<HTMLPreElement>('.prose pre');
  for (const block of blocks) {
    if (block.querySelector(':scope > .code-copy')) continue;
    if (!block.querySelector('code')) continue;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.textContent = 'Copy';
    block.append(button);
  }
}

/** Copies the nearest code block's text and briefly signals success. */
function handleCopyClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const trigger = target?.closest<HTMLButtonElement>('.code-copy');
  if (!trigger) return;
  const block = trigger.closest('pre');
  const code = block?.querySelector('code');
  if (!code) return;

  const write = navigator.clipboard?.writeText(code.innerText);
  if (!write) return;

  write
    .then(() => {
      trigger.dataset.copied = 'true';
      trigger.textContent = 'Copied';
      window.setTimeout(() => {
        delete trigger.dataset.copied;
        trigger.textContent = 'Copy';
      }, COPY_RESET_MS);
    })
    .catch(() => {
      // Clipboard denied (insecure context or permission) — no-op.
    });
}

/**
 * Highlights the TOC entry for the heading currently in view.
 *
 * Uses a single IntersectionObserver over the article headings and toggles
 * `.toc-active` on the matching rail link. Rebuilt on every Turbo visit because
 * Turbo swaps the `<body>` without re-running island effects.
 */
let tocObserver: IntersectionObserver | null = null;

function setupTocScrollSpy(): void {
  tocObserver?.disconnect();
  tocObserver = null;

  const rail = document.querySelector<HTMLElement>('.toc-rail');
  if (!rail) return;

  const links = Array.from(rail.querySelectorAll<HTMLAnchorElement>('a[href^="#"]'));
  if (links.length === 0) return;

  const byId = new Map<string, HTMLAnchorElement>();
  for (const link of links) {
    byId.set(decodeURIComponent(link.hash.slice(1)), link);
  }

  const headings = Array.from(
    document.querySelectorAll<HTMLElement>('.prose :is(h2, h3, h4)'),
  ).filter((h) => byId.has(h.id));
  if (headings.length === 0) return;

  const setActive = (id: string) => {
    for (const link of links) link.classList.remove('toc-active');
    byId.get(id)?.classList.add('toc-active');
  };

  tocObserver = new IntersectionObserver(
    (entries) => {
      // Prefer the topmost heading currently intersecting the viewport.
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length > 0) setActive(visible[0].target.id);
    },
    { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
  );

  for (const heading of headings) tocObserver.observe(heading);
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PagefindResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global code-copy + TOC scroll-spy (see file header for why they live here).
  // Injection runs once after hydration and again after each Turbo visit,
  // because Turbo swaps the `<body>` without re-running island effects.
  useEffect(() => {
    injectCopyButtons();
    setupTocScrollSpy();
    document.addEventListener('click', handleCopyClick);
    document.addEventListener('turbo:load', injectCopyButtons);
    document.addEventListener('turbo:load', setupTocScrollSpy);
    return () => {
      document.removeEventListener('click', handleCopyClick);
      document.removeEventListener('turbo:load', injectCopyButtons);
      document.removeEventListener('turbo:load', setupTocScrollSpy);
      tocObserver?.disconnect();
      tocObserver = null;
    };
  }, []);

  // `⌘K` / `Ctrl+K` opens the palette; `Escape` closes it.
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, []);

  // Focus the input when the palette opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const doSearch = useCallback(async (q: string) => {
    const pagefind = window.Pagefind;
    if (!pagefind) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const search = await pagefind.search(q.trim());
      const items = await Promise.all(search.results.slice(0, RESULT_LIMIT).map((r) => r.data()));
      setResults(items);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    setActiveIndex(-1);

    if (timerRef.current) clearTimeout(timerRef.current);

    if (value.trim().length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      doSearch(value);
    }, DEBOUNCE_MS);
  };

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!results.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      const target = results[activeIndex];
      setOpen(false);
      window.location.assign(target.url);
    }
  };

  const hasQuery = query.trim().length > 0;
  const noResults = hasQuery && !loading && results.length === 0;

  return (
    <>
      {/* Trigger — a compact search button in the header. */}
      <button
        type="button"
        class="btn btn-ghost btn-sm gap-2 border border-base-300 bg-base-100 font-normal text-base-content/60"
        onClick={() => setOpen(true)}
        aria-label="Search documentation"
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span class="hidden md:inline">Search</span>
        <kbd class="kbd kbd-sm hidden md:inline-flex">⌘K</kbd>
      </button>

      {/* Command palette modal. */}
      {open ? (
        <div
          class="fixed inset-0 z-[400] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            class="w-full max-w-xl overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Search documentation"
          >
            <div class="flex items-center gap-3 border-b border-base-300 px-4">
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="shrink-0 text-base-content/40"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={inputRef}
                type="search"
                class="input h-14 flex-1 border-0 bg-transparent px-0 text-base outline-none focus:outline-none"
                placeholder="Search documentation…"
                value={query}
                onInput={(e) => handleInput((e.target as HTMLInputElement).value)}
                onKeyDown={handleKeyDown}
                role="combobox"
                aria-expanded={hasQuery}
                aria-label="Search documentation"
                aria-controls="search-results"
                autocomplete="off"
              />
              <kbd class="kbd kbd-sm shrink-0">Esc</kbd>
            </div>

            <ul class="max-h-[52vh] overflow-y-auto p-2" id="search-results" role="listbox">
              {loading ? (
                <li class="flex items-center gap-2 px-3 py-3 text-sm text-base-content/60">
                  <span class="loading loading-spinner loading-xs" aria-hidden="true" /> Searching…
                </li>
              ) : noResults ? (
                <li class="px-3 py-3 text-sm text-base-content/60">No results for “{query}”</li>
              ) : results.length > 0 ? (
                results.map((r, i) => (
                  <li key={r.url} role="option" aria-selected={i === activeIndex}>
                    <a
                      class={`flex flex-col rounded-field px-3 py-2.5 no-underline transition-colors ${
                        i === activeIndex ? 'bg-primary/10' : 'hover:bg-base-200'
                      }`}
                      href={r.url}
                      onClick={() => setOpen(false)}
                      onMouseEnter={() => setActiveIndex(i)}
                    >
                      <span class="font-semibold text-base-content">{r.meta.title || r.url}</span>
                      <span class="mt-0.5 line-clamp-2 text-xs leading-snug text-base-content/60">
                        {stripHtml(r.excerpt)}
                      </span>
                    </a>
                  </li>
                ))
              ) : (
                <li class="px-3 py-3 text-sm text-base-content/50">
                  Type to search the documentation.
                </li>
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
