/**
 * Memoized Shiki syntax highlighter for the content layer.
 *
 * Built once per process and shared across every markdown fence block.
 * Uses Shiki's dual-theme support (CSS variables) so a future theme toggle
 * can flip light/dark without re-highlighting.
 *
 * Languages are registered on demand — the first fence with a new language
 * loads it; subsequent fences reuse the already-loaded grammar.
 */

import { createHighlighter } from 'shiki';

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let _highlighter: Highlighter | null = null;
let _creatable: Promise<Highlighter> | null = null;

function create(): Promise<Highlighter> {
  if (!_creatable) {
    _creatable = createHighlighter({
      themes: ['github-light', 'github-dark'],
      langs: [], // start empty; loaded on demand
    });
  }
  return _creatable;
}

const _loaded = new Set<string>();

async function ensureLang(highlighter: Highlighter, lang: string): Promise<void> {
  if (_loaded.has(lang)) return;

  try {
    // Shiki resolves the grammar id on load; an unknown id throws and falls
    // back to plain text below. The type of `loadLanguage` only accepts
    // `LanguageInput | SpecialLanguage` (no raw string) because this
    // highlighter was created with an empty `langs` list, so a raw language id
    // is intentionally passed through as a runtime-resolved string.
    // @ts-expect-error — a raw bundled language id is resolved (or rejected) at runtime.
    await highlighter.loadLanguage(lang);
  } catch {
    // Unknown language — fall back to plain text rendering.
    return;
  }

  _loaded.add(lang);
}

export async function getHighlighter(): Promise<Highlighter> {
  if (!_highlighter) {
    _highlighter = await create();
  }
  return _highlighter;
}

export async function highlightCode(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();

  const resolvedLang = lang || 'text';
  await ensureLang(highlighter, resolvedLang);

  const available = highlighter.getLoadedLanguages();
  const langToUse = available.includes(resolvedLang) ? resolvedLang : 'text';

  if (langToUse === 'text' && !available.includes('text')) {
    await ensureLang(highlighter, 'text');
  }

  return highlighter.codeToHtml(code, {
    lang: langToUse,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
}
