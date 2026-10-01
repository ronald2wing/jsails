/**
 * Pagination helper for server components: builds prev/next call-attribute maps
 * from a {@link Page} so component authors never hand-roll the pager buttons.
 *
 * The returned attribute maps spread onto a `call` trigger element, so a
 * component renders a pager with two spread elements rather than writing
 * `call` invocations with serialized numeric args.
 *
 * Pure, inert, no I/O — never touches a connection, the runtime, or a snapshot.
 */

import { DEFAULT_MAX_PAGE_SIZE } from '../api/pagination.js';
import type { Page } from '../api/pagination.js';
import type { ServerComponentCallAttrs } from './component.js';
import { ARGS_ATTRIBUTE, CALL_ATTRIBUTE } from './protocol.js';
import { ServerComponentRuntimeError } from './runtime/value-errors.js';

/**
 * Options for {@link pagerAttrs}.
 *
 * Every field is optional and defaults to a conventional name so a component
 * using `page`/`pageSize` state fields and a `page` action needs no options.
 */
export interface ServerComponentPagerOptions {
  /** Action name the pager calls. Defaults to `'page'`. */
  action?: string;
  /** State field name for the page number. Defaults to `'page'`. */
  pageField?: string;
  /** State field name for the page size. Defaults to `'pageSize'`. */
  pageSizeField?: string;
  /** Upper bound for the page size emitted in call args. Defaults to 100. */
  maxPageSize?: number;
}

/**
 * Build prev/next {@link ServerComponentCallAttrs} from a {@link Page}.
 *
 * Each direction returns `null` when the page has no link in that direction
 * (`page.previous` or `page.next` is `null`), so the component can skip that
 * button entirely. Otherwise the returned map calls the configured action with
 * `{ <pageField>: <target page>, <pageSizeField>: <clamped pageSize> }`.
 *
 * The emitted `pageSize` is clamped to `maxPageSize` as a defensive bound,
 * even though the component author owns the real bound on the state field.
 */
export function pagerAttrs(
  page: Page<unknown>,
  options: ServerComponentPagerOptions = {},
): { previous: ServerComponentCallAttrs | null; next: ServerComponentCallAttrs | null } {
  const action = options.action ?? 'page';
  const pageField = options.pageField ?? 'page';
  const pageSizeField = options.pageSizeField ?? 'pageSize';
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

  validatePagerOptions(action, pageField, pageSizeField, maxPageSize);

  const clampedPageSize = Math.min(page.pageSize, maxPageSize);

  const build = (targetPage: number | null): ServerComponentCallAttrs | null => {
    if (targetPage === null) {
      return null;
    }
    return {
      [CALL_ATTRIBUTE]: action,
      [ARGS_ATTRIBUTE]: JSON.stringify({
        [pageField]: targetPage,
        [pageSizeField]: clampedPageSize,
      }),
    };
  };

  return { previous: build(page.previous), next: build(page.next) };
}

function validatePagerOptions(
  action: string,
  pageField: string,
  pageSizeField: string,
  maxPageSize: number,
): void {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new ServerComponentRuntimeError('pager action must be a non-empty string');
  }
  if (typeof pageField !== 'string' || pageField.trim() === '') {
    throw new ServerComponentRuntimeError('pager page field must be a non-empty string');
  }
  if (typeof pageSizeField !== 'string' || pageSizeField.trim() === '') {
    throw new ServerComponentRuntimeError('pager page size field must be a non-empty string');
  }
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new ServerComponentRuntimeError('pager max page size must be a positive integer');
  }
}
