/**
 * Asset helper tests (`jsails/seo`).
 *
 * Covers {@link imageAttrs} and {@link fontFace}: attribute maps, lazy vs
 * eager loading, `srcset`/`sizes` pass-through, and CSS font-face escaping.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fontFace, imageAttrs } from '../../src/seo/asset-helpers.js';
import type { FontFaceInput, ImageAttrsInput } from '../../src/seo/asset-helpers.js';

describe('imageAttrs', () => {
  it('sets width, height, src, and lazy loading by default', () => {
    const input: ImageAttrsInput = { src: '/img/hero.webp', width: 800, height: 600 };
    const attrs = imageAttrs(input);

    assert.equal(attrs['src'], '/img/hero.webp');
    assert.equal(attrs['width'], '800');
    assert.equal(attrs['height'], '600');
    assert.equal(attrs['loading'], 'lazy');
    assert.equal(attrs['fetchpriority'], undefined);
    assert.equal(attrs['alt'], undefined);
    assert.equal(attrs['sizes'], undefined);
    assert.equal(attrs['srcset'], undefined);
  });

  it('flips to eager loading and fetchpriority=high when priority is set', () => {
    const input: ImageAttrsInput = { src: '/hero.webp', width: 1200, height: 630, priority: true };
    const attrs = imageAttrs(input);

    assert.equal(attrs['loading'], 'eager');
    assert.equal(attrs['fetchpriority'], 'high');
  });

  it('passes through alt when supplied', () => {
    const input: ImageAttrsInput = {
      src: '/logo.png',
      width: 200,
      height: 80,
      alt: 'Site logo',
    };
    const attrs = imageAttrs(input);

    assert.equal(attrs['alt'], 'Site logo');
  });

  it('passes through sizes and srcset when supplied', () => {
    const input: ImageAttrsInput = {
      src: '/photo.jpg',
      width: 1600,
      height: 900,
      sizes: '(max-width: 800px) 100vw, 50vw',
      srcset: '/photo-800.jpg 800w, /photo-1600.jpg 1600w',
    };
    const attrs = imageAttrs(input);

    assert.equal(attrs['sizes'], '(max-width: 800px) 100vw, 50vw');
    assert.equal(attrs['srcset'], '/photo-800.jpg 800w, /photo-1600.jpg 1600w');
    // priority is false, so lazy loading still applies
    assert.equal(attrs['loading'], 'lazy');
  });

  it('priority overrides lazy and retains sizes/srcset', () => {
    const input: ImageAttrsInput = {
      src: '/hero.jpg',
      width: 2400,
      height: 1200,
      priority: true,
      sizes: '100vw',
      srcset: '/hero-1200.jpg 1200w, /hero-2400.jpg 2400w',
    };
    const attrs = imageAttrs(input);

    assert.equal(attrs['loading'], 'eager');
    assert.equal(attrs['fetchpriority'], 'high');
    assert.equal(attrs['sizes'], '100vw');
    assert.equal(attrs['srcset'], '/hero-1200.jpg 1200w, /hero-2400.jpg 2400w');
  });
});

describe('fontFace', () => {
  it('builds a minimal @font-face block', () => {
    const input: FontFaceInput = {
      family: 'Inter',
      src: 'url(/fonts/inter-var.woff2) format("woff2")',
    };
    const css = fontFace(input);

    assert.equal(
      css,
      '@font-face{font-family:"Inter";src:url(/fonts/inter-var.woff2) format("woff2")}',
    );
  });

  it('includes optional weight, style, and display', () => {
    const input: FontFaceInput = {
      family: 'Inter',
      src: 'url(/fonts/inter-bold.woff2) format("woff2")',
      weight: 700,
      style: 'normal',
      display: 'swap',
    };
    const css = fontFace(input);

    assert.equal(
      css,
      '@font-face{font-family:"Inter";src:url(/fonts/inter-bold.woff2) format("woff2");font-weight:700;font-style:normal;font-display:swap}',
    );
  });

  it('escapes double-quotes and backslashes in the family name', () => {
    const input: FontFaceInput = {
      family: 'My "Fancy" Font',
      src: 'url(/f.woff2)',
    };
    const css = fontFace(input);

    assert.equal(css, '@font-face{font-family:"My \\"Fancy\\" Font";src:url(/f.woff2)}');
  });

  it('escapes a backslash in the family name', () => {
    const input: FontFaceInput = {
      family: 'Font\\Name',
      src: 'url(/f.woff2)',
    };
    const css = fontFace(input);

    assert.equal(css, '@font-face{font-family:"Font\\\\Name";src:url(/f.woff2)}');
  });

  it('replaces control characters with CSS escapes in the family name', () => {
    const input: FontFaceInput = {
      family: 'Bad\x00Font',
      src: 'url(/f.woff2)',
    };
    const css = fontFace(input);

    // U+0000 becomes \0000 (padded + trailing space per CSS spec)
    assert.match(css, /\\0000 /);
    assert.ok(css.startsWith('@font-face{font-family:'));
    assert.ok(css.includes('src:url(/f.woff2)'));
  });

  it('handles a number weight as a stringified value', () => {
    const input: FontFaceInput = {
      family: 'Roboto',
      src: 'url(/r.woff2)',
      weight: 400,
    };
    const css = fontFace(input);

    assert.equal(css, '@font-face{font-family:"Roboto";src:url(/r.woff2);font-weight:400}');
  });
});
