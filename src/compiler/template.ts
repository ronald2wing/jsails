/**
 * The U3 seam: lower a `view` region that carries a `<template>` block to JSX.
 *
 * A `view` region may be authored as raw JSX (the shipped dialect) or as a
 * `<template>` block in the Vue-like grammar. This module is the single entry
 * point the emitter calls: it detects a leading `<template>` block, parses and
 * lowers it, and otherwise returns the region unchanged.
 *
 * Detection is a **leading** check — the block must be the first non-whitespace
 * content of the region — not a substring search, so a `<template>` string
 * inside JSX is never mistaken for the dialect.
 */

import { DiagnosticBag } from './diagnostics.js';
import { collectTemplateComponents, type ComponentTagRef } from './resolve-components.js';
import { parseTemplate, type TemplateParseReporter } from './template-ast.js';
import { lowerTemplate } from './template-lower.js';

const OPEN = '<template>';
const CLOSE = '</template>';

/** The lowered view plus the source offset its template body starts at. */
export interface LoweredTemplateRegion {
  readonly code: string;
  /**
   * Absolute character offset, in the component source, of the first character
   * the lowered `code` was produced from. Raw JSX lowers to itself, so its
   * offset is the region's own start; a `<template>` block lowers its body, so
   * the offset points past `<template>`.
   */
  readonly offset: number;
  /**
   * Whether the region was a `<template>` block. A `<template>` block's
   * directives are consumed by template lowering, so the emitter must NOT run
   * the raw-JSX `js-*` text transform over its output — doing so could lower a
   * literal `js-` that is now only text or an attribute value.
   */
  readonly wasTemplate: boolean;
  /**
   * Capitalized element tags found in a `<template>` block, with source-absolute
   * positions. Absent for the raw-JSX dialect, whose tags the emitter collects
   * from the region string directly. Carried here because only this function
   * holds the parsed template tree, whose nodes already carry positions — so the
   * tag positions are exact and no lowering-to-source offset mapping is needed.
   */
  readonly components?: readonly ComponentTagRef[];
}

/**
 * Lower a `view` region to JSX. Returns the region unchanged when it does not
 * open with a `<template>` block.
 *
 * `baseOffset` is the region's absolute offset in the component source, used to
 * report the template body's position for diagnostics. `bag` is required:
 * lowering a `<template>` can fail, and a bag that silently drops those errors
 * would defeat the collect-then-decide contract — every caller already owns a
 * bag, so there is no reason to make it optional.
 */
export function lowerTemplateRegion(
  view: string,
  baseOffset: number,
  bag: DiagnosticBag,
): LoweredTemplateRegion {
  const trimmedStart = view.replace(/^\s+/, '');
  if (!trimmedStart.startsWith(OPEN)) {
    return { code: view, offset: baseOffset, wasTemplate: false };
  }

  const bodyStart = view.indexOf(OPEN) + OPEN.length;
  const bodyEnd = view.lastIndexOf(CLOSE);

  const body =
    bodyEnd < bodyStart
      ? // The opening tag is present but the closing tag is missing.
        view.slice(bodyStart)
      : view.slice(bodyStart, bodyEnd);

  const absolute = baseOffset + bodyStart;
  // The parser reports body-relative offsets; the region base translates them
  // to file-absolute positions for the bag's frame rendering.
  const report: TemplateParseReporter = (code, message, subject, start, end) => {
    bag.errorAt(code, message, absolute + start, absolute + end);
  };

  const nodes = parseTemplate(body, report);
  if (nodes.length === 0 && bag.hasErrors) {
    // A parse error aborted the tree; there is nothing to lower.
    return { code: '', offset: absolute, wasTemplate: true, components: Object.freeze([]) };
  }

  const ctx = { bag, baseOffset: absolute };
  return {
    code: lowerTemplate(nodes, ctx),
    offset: absolute,
    wasTemplate: true,
    components: collectTemplateComponents(nodes, absolute),
  };
}
