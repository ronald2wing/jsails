/**
 * Thin re-export of Preact's automatic JSX runtime.
 *
 * `jsxImportSource: "jsails"` resolves JSX to this module, which delegates to
 * Preact with no bespoke virtual DOM and no JSX-emission logic of its own. The
 * JSails server-only boundary is a component annotation in
 * `contracts/component.ts`; this runtime neither reads nor enforces it.
 */

export * from 'preact/jsx-runtime';
