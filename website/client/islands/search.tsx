/**
 * Client-side search island for the docs site.
 *
 * Delegates to Pagefind (build-time index, fuzzy + ranked, zero server).
 * The Pagefind script is loaded via a `<script src="/pagefind/pagefind.js" defer>`
 * in the document `<head>`, so `window.Pagefind` is available by hydration time.
 *
 * Navigation uses ordinary `<a href>` — Turbo Drive owns soft navigation.
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

/** Strip HTML tags from a snippet string. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PagefindResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close the dropdown when clicking outside.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

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
    setOpen(true);

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

  const hasQuery = query.trim().length > 0;
  const showResults = open && hasQuery;
  const noResults = showResults && !loading && results.length === 0;
  const hasResults = showResults && results.length > 0;

  return (
    <div class="search-island" ref={containerRef}>
      <input
        type="search"
        class="search-input"
        placeholder="Search docs..."
        value={query}
        onInput={(e) => handleInput((e.target as HTMLInputElement).value)}
        onFocus={() => {
          if (hasQuery) setOpen(true);
        }}
        aria-label="Search documentation"
      />
      {hasResults ? (
        <ul class="search-results">
          {results.map((r) => (
            <li key={r.url}>
              <a class="search-result-item" href={r.url} onClick={() => setOpen(false)}>
                <span class="search-result-title">{r.meta.title || r.url}</span>
                <span class="search-result-snippet">{stripHtml(r.excerpt)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <ul class="search-results">
          <li class="search-no-results">Searching…</li>
        </ul>
      ) : noResults ? (
        <ul class="search-results">
          <li class="search-no-results">No results for "{query}"</li>
        </ul>
      ) : null}
    </div>
  );
}
