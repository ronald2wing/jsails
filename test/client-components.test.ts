/**
 * DOMglue binding-layer tests (Node-import safe).
 *
 * These exercise the DOM half of the component story against a small structural
 * `document`/element double: bootstrap from the server markers, delegated
 * input/change capture, click/submit action dispatch with explicit args, scope
 * and island exclusion, morph retargeting with caret preservation, the 422 vs
 * fatal split, and dispose/rebind. They deliberately do NOT simulate a real
 * browser or Preact hydration — that is owned by the integration fixture.
 *
 * The double is a focused contract stand-in, not a blanket DOM mock: it models
 * only the members `components.ts` touches, so the binding layer's own decisions
 * (which events it handles, what it sends, how it morphs) are asserted without
 * claiming any visual proof.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMPONENT_BLOCKED_MESSAGE,
  ComponentBindingError,
  createComponentBindings,
  parseActionArgs,
  readControlValue,
  type ComponentBindings,
  type ComponentDocument,
  type ComponentElement,
} from '../src/client/components.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  MODEL_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../src/server-components/protocol.js';
import {
  ISLAND_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  type IslandManager,
  type JsailsEvent,
} from '../src/client/islands.js';

// ---------------------------------------------------------------------------
// Structural doubles
// ---------------------------------------------------------------------------

const ORIGIN = 'http://localhost';

interface FakeElement extends ComponentElement {
  readonly attributes: Map<string, string>;
  readonly children: FakeElement[];
  parentElement: FakeElement | null;
  isConnected: boolean;
  textContent: string | null;
  innerHTML: string;
  value?: string;
  checked?: boolean;
  type?: string;
  multiple?: boolean;
  selectedOptions?: ArrayLike<{ readonly value: string }>;
  readonly listeners: Map<string, Array<(event: JsailsEvent) => void>>;
}

function fakeElement(
  tagName: string,
  attrs: Record<string, string> = {},
  options: { id?: string } = {},
): FakeElement {
  const attributes = new Map<string, string>(Object.entries(attrs));
  const element: FakeElement = {
    tagName,
    id: options.id ?? attributes.get('id') ?? '',
    attributes,
    children: [],
    parentElement: null,
    isConnected: true,
    textContent: null,
    innerHTML: '',
    // A real DOM reflects these content attributes onto IDL properties; the
    // binding layer reads the properties, so the double must too.
    type: attributes.get('type'),
    multiple: attributes.has('multiple') ? true : undefined,
    listeners: new Map(),
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
      if (name === 'type') {
        element.type = value;
      } else if (name === 'multiple') {
        element.multiple = true;
      }
    },
    removeAttribute: (name) => {
      attributes.delete(name);
      if (name === 'type') {
        element.type = undefined;
      } else if (name === 'multiple') {
        element.multiple = false;
      }
    },
    hasAttribute: (name) => attributes.has(name),
    querySelector: (selector) => querySelector(element, selector),
    querySelectorAll: (selector) => querySelectorAll(element, selector),
    closest: (selector) => closest(element, selector),
    addEventListener: (type, listener) => {
      const list = element.listeners.get(type) ?? [];
      list.push(listener);
      element.listeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = (element.listeners.get(type) ?? []).filter((l) => l !== listener);
      element.listeners.set(type, list);
    },
  };
  return element;
}

function append(parent: FakeElement, child: FakeElement): FakeElement {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
}

function descendants(root: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of root.children) {
    out.push(child, ...descendants(child));
  }
  return out;
}

/** Minimal selector support: `[attr]`, `tag`, `#id`, and `tag[attr]`. */
function matches(element: FakeElement, selector: string): boolean {
  const attrMatch = /^\[([^\]]+)\]$/.exec(selector);
  if (attrMatch !== null) {
    return element.hasAttribute(attrMatch[1]!);
  }
  const idMatch = /^#(.+)$/.exec(selector);
  if (idMatch !== null) {
    return element.id === idMatch[1];
  }
  const tagAttr = /^([a-z]+)\[([^\]]+)\]$/.exec(selector);
  if (tagAttr !== null) {
    return element.tagName.toLowerCase() === tagAttr[1] && element.hasAttribute(tagAttr[2]!);
  }
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

function querySelectorAll(root: FakeElement, selector: string): FakeElement[] {
  return descendants(root).filter((element) => matches(element, selector));
}

function querySelector(root: FakeElement, selector: string): FakeElement | null {
  return querySelectorAll(root, selector)[0] ?? null;
}

function closest(element: FakeElement, selector: string): FakeElement | null {
  let current: FakeElement | null = element;
  while (current !== null) {
    if (matches(current, selector)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

interface FakeDocument extends ComponentDocument {
  readonly roots: FakeElement[];
  readonly listeners: Map<string, Array<(event: JsailsEvent) => void>>;
}

function fakeDocument(roots: FakeElement[] = []): FakeDocument {
  const listeners = new Map<string, Array<(event: JsailsEvent) => void>>();
  const all = (): FakeElement[] => roots.flatMap((root) => [root, ...descendants(root)]);
  return {
    roots,
    listeners,
    querySelectorAll: (selector) => all().filter((element) => matches(element, selector)),
    querySelector: (selector) => all().find((element) => matches(element, selector)) ?? null,
    getElementById: (id) => all().find((element) => element.id === id) ?? null,
    addEventListener: (type, listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener: (type, listener) => {
      const list = (listeners.get(type) ?? []).filter((l) => l !== listener);
      listeners.set(type, list);
    },
    dispatchEvent: () => false,
  };
}

function fakeEvent(
  type: string,
  target: FakeElement | null,
  detail?: unknown,
): JsailsEvent & { prevented: boolean } {
  const event = {
    type,
    target,
    detail,
    prevented: false,
    preventDefault: () => {
      event.prevented = true;
    },
  };
  return event;
}

function dispatch(doc: FakeDocument, event: JsailsEvent): void {
  for (const listener of doc.listeners.get(event.type) ?? []) {
    listener(event);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeToken(state: Record<string, unknown>): string {
  const payload = {
    v: 1,
    component: 'Counter',
    id: 'counter-1',
    state,
    page: { path: '/', params: {} },
    origin: ORIGIN,
    subject: null,
    expiresAt: Date.now() + 3_600_000,
  };
  return `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${'A'.repeat(43)}`;
}

function componentRoot(
  id: string,
  state: Record<string, unknown> = { title: 'hello', count: 0 },
): FakeElement {
  return fakeElement('div', {
    id,
    [COMPONENT_ATTRIBUTE]: 'Counter',
    [COMPONENT_SNAPSHOT_ATTRIBUTE]: makeToken(state),
    [COMPONENT_CSRF_ATTRIBUTE]: 'csrf-token-1',
  });
}

function modelInput(name: string, value: string, type = 'text'): FakeElement {
  const input = fakeElement('input', { [MODEL_ATTRIBUTE]: name, type });
  input.value = value;
  return input;
}

interface Harness {
  readonly doc: FakeDocument;
  readonly bindings: ComponentBindings;
  readonly morphs: Array<{ target: string; html: string }>;
  readonly errors: unknown[];
  readonly fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  resolveNext(response: Response): void;
}

function harness(
  roots: FakeElement[],
  options: {
    islands?: IslandManager;
    morph?: (target: string, html: string) => Promise<void>;
    fetch?: (url: string, init: { body: string }) => Promise<Response>;
  } = {},
): Harness {
  const doc = fakeDocument(roots);
  const morphs: Array<{ target: string; html: string }> = [];
  const errors: unknown[] = [];
  const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let pending: ((response: Response) => void) | null = null;

  const bindings = createComponentBindings({
    document: doc,
    origin: ORIGIN,
    morph:
      options.morph ??
      (async (target, html) => {
        morphs.push({ target, html });
      }),
    ...(options.islands === undefined ? {} : { islands: options.islands }),
    onError: (error) => {
      errors.push(error);
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      if (options.fetch !== undefined) {
        return options.fetch(url, init);
      }
      return new Promise<Response>((resolve) => {
        pending = resolve;
      });
    },
  });

  return {
    doc,
    bindings,
    morphs,
    errors,
    fetchCalls,
    resolveNext(response) {
      assert.ok(pending, 'no pending fetch to resolve');
      const resolve = pending;
      pending = null;
      resolve(response);
    },
  };
}

function successResponse(
  sequence: number,
  state: Record<string, unknown>,
  html = '<div>ok</div>',
): Response {
  return new Response(JSON.stringify({ sequence, snapshot: makeToken(state), html }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function invalidResponse(
  sequence: number,
  errors: Record<string, string>,
  html = '<div>err</div>',
): Response {
  return new Response(JSON.stringify({ sequence, errors, html }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('readControlValue', () => {
  it('reads text, checkbox, number, and multi-select values', () => {
    const text = modelInput('title', 'hi');
    assert.equal(readControlValue(text), 'hi');

    const checkbox = fakeElement('input', { type: 'checkbox' });
    checkbox.checked = true;
    assert.equal(readControlValue(checkbox), true);

    const number = modelInput('count', '42', 'number');
    assert.equal(readControlValue(number), 42);

    const emptyNumber = modelInput('count', '', 'number');
    assert.equal(readControlValue(emptyNumber), '');

    const select = fakeElement('select', { multiple: 'true' });
    select.multiple = true;
    select.selectedOptions = [{ value: 'a' }, { value: 'b' }];
    assert.deepEqual(readControlValue(select), ['a', 'b']);
  });
});

describe('parseActionArgs', () => {
  it('accepts absent/empty as an empty object and rejects malformed JSON', () => {
    assert.deepEqual(parseActionArgs(null), {});
    assert.deepEqual(parseActionArgs(''), {});
    assert.deepEqual(parseActionArgs('{"id":1}'), { id: 1 });
    assert.equal(parseActionArgs('{bad'), null);
    assert.equal(parseActionArgs('[1,2]'), null);
    assert.equal(parseActionArgs('"str"'), null);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe('createComponentBindings bootstrap', () => {
  it('binds every component root and emits the legacy readiness marker', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);

    h.bindings.mountAll();

    assert.equal(h.bindings.size, 1);
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');
  });

  it('reports a root missing its snapshot or CSRF marker without binding', () => {
    const root = fakeElement('div', { id: 'counter-1', [COMPONENT_ATTRIBUTE]: 'Counter' });
    const h = harness([root]);

    h.bindings.mountAll();

    assert.equal(h.bindings.size, 0);
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0] instanceof ComponentBindingError);
  });

  it('rejects invalid construction options', () => {
    const doc = fakeDocument();
    assert.throws(
      () => createComponentBindings({ document: doc, origin: ORIGIN, morph: undefined as never }),
      ComponentBindingError,
    );
    assert.throws(
      () => createComponentBindings({ document: doc, origin: '', morph: async () => {} }),
      ComponentBindingError,
    );
  });
});

// ---------------------------------------------------------------------------
// Delegated input/change
// ---------------------------------------------------------------------------

describe('delegated input capture', () => {
  it('writes a model control value into the controller on input', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'changed';
    dispatch(h.doc, fakeEvent('input', input));

    // The next action carries the captured value.
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'changed' });
  });

  it('ignores a control outside any component root', () => {
    const root = componentRoot('counter-1');
    const outside = modelInput('title', 'x');
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('input', outside));
    // No binding exists for the outside control; nothing is dispatched.
    assert.equal(h.fetchCalls.length, 0);
  });

  it('excludes controls owned by a client island', () => {
    const root = componentRoot('counter-1');
    const island = append(root, fakeElement('div', { [ISLAND_ATTRIBUTE]: 'counter' }));
    const islandInput = append(island, modelInput('title', 'island-owned'));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('input', islandInput));

    // The island control is out of scope: a subsequent action sends no update.
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    dispatch(h.doc, fakeEvent('click', trigger));
    assert.deepEqual(h.fetchCalls[0]!.body.updates, {});
  });
});

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

describe('action dispatch', () => {
  it('dispatches a click action with explicit args and captured values', () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'increment', [ARGS_ATTRIBUTE]: '{"by":2}' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'typed';
    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.equal(h.fetchCalls.length, 1);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'increment', args: { by: 2 } });
    assert.deepEqual(h.fetchCalls[0]!.body.updates, { title: 'typed' });
  });

  it('dispatches a submit action and prevents the native default', () => {
    const root = componentRoot('counter-1');
    const form = append(root, fakeElement('form', { [SUBMIT_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('submit', form);
    dispatch(h.doc, event);

    assert.equal(event.prevented, true);
    assert.deepEqual(h.fetchCalls[0]!.body.action, { name: 'save', args: {} });
  });

  it('reports malformed args and does not dispatch or prevent default', () => {
    const root = componentRoot('counter-1');
    const trigger = append(
      root,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'save', [ARGS_ATTRIBUTE]: '{bad' }),
    );
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', trigger);
    dispatch(h.doc, event);

    assert.equal(event.prevented, false);
    assert.equal(h.fetchCalls.length, 0);
    assert.equal(h.errors.length, 1);
  });

  it('ignores a click with no call marker', () => {
    const root = componentRoot('counter-1');
    const plain = append(root, fakeElement('button'));
    const h = harness([root]);
    h.bindings.mountAll();

    const event = fakeEvent('click', plain);
    dispatch(h.doc, event);

    assert.equal(event.prevented, false);
    assert.equal(h.fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Morph, retarget, caret, 422, fatal
// ---------------------------------------------------------------------------

describe('render handling', () => {
  it('morphs the root, retargets the controller, and reapplies working values', async () => {
    // Case 1: the value that was submitted is normalized on the server, so the
    // server render wins over the already-sent local edit.
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'typed';
    dispatch(h.doc, fakeEvent('click', trigger));

    // The morph replaces the root element with a fresh one carrying new markup.
    const replacement = componentRoot('counter-1', { title: 'server', count: 5 });
    const replacementInput = append(replacement, modelInput('title', 'server'));
    h.doc.roots[0] = replacement;
    h.resolveNext(successResponse(1, { title: 'server', count: 5 }));
    await flush();

    assert.deepEqual(h.morphs, [{ target: 'counter-1', html: '<div>ok</div>' }]);
    // The submitted edit was incorporated (and normalized) by the server.
    assert.equal(replacementInput.value, 'server');
    assert.equal(replacement.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');

    // Case 2: a newer local edit made while the response is in flight is not
    // part of the server render and must survive it.
    const laterRoot = componentRoot('counter-1');
    const laterInput = append(laterRoot, modelInput('title', 'hello'));
    const laterTrigger = append(laterRoot, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const later = harness([laterRoot]);
    later.bindings.mountAll();

    laterInput.value = 'typed';
    dispatch(later.doc, fakeEvent('click', laterTrigger));
    // The response is still delayed; the user edits again before it arrives.
    laterInput.value = 'newer';
    dispatch(later.doc, fakeEvent('input', laterInput));

    const laterReplacement = componentRoot('counter-1', { title: 'server', count: 5 });
    const laterReplacementInput = append(laterReplacement, modelInput('title', 'server'));
    later.doc.roots[0] = laterReplacement;
    later.resolveNext(successResponse(1, { title: 'server', count: 5 }));
    await flush();

    // Server state is canonical, but the newer unsent edit survives on top.
    assert.equal(laterReplacementInput.value, 'newer');
  });

  it('re-keys a fully replaced root so the next input/click reuse the same binding', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // A render fully replaces the root element with a fresh one.
    dispatch(h.doc, fakeEvent('click', trigger));
    const replacement = componentRoot('counter-1', { title: 'server', count: 1 });
    const replacementInput = append(replacement, modelInput('title', 'server'));
    const replacementTrigger = append(
      replacement,
      fakeElement('button', { [CALL_ATTRIBUTE]: 'increment' }),
    );
    h.doc.roots[0] = replacement;
    h.resolveNext(successResponse(1, { title: 'server', count: 1 }));
    await flush();

    // Re-keyed, not duplicated: the stale key was removed and the new one added.
    assert.equal(h.bindings.size, 1);

    // The detached old element no longer routes events to the controller.
    input.value = 'stale';
    dispatch(h.doc, fakeEvent('input', input));

    // A new input on the replacement and its click reuse the same controller.
    replacementInput.value = 'fresh';
    dispatch(h.doc, fakeEvent('input', replacementInput));
    dispatch(h.doc, fakeEvent('click', replacementTrigger));

    assert.equal(h.fetchCalls.length, 2);
    assert.deepEqual(h.fetchCalls[1]!.body.action, { name: 'increment', args: {} });
    assert.deepEqual(h.fetchCalls[1]!.body.updates, { title: 'fresh' });
  });

  it('leaves an unchanged control untouched so its caret is preserved', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    // No local edit: the control already matches the server value.
    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    assert.equal(input.value, 'hello');
  });

  it('morphs the server HTML on a 422 and keeps local edits', async () => {
    const root = componentRoot('counter-1');
    const input = append(root, modelInput('title', 'hello'));
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    input.value = 'too-long';
    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(invalidResponse(1, { title: 'Too long' }, '<div>invalid</div>'));
    await flush();

    assert.deepEqual(h.morphs, [{ target: 'counter-1', html: '<div>invalid</div>' }]);
    assert.equal(input.value, 'too-long');
  });

  it('shows the fixed plaintext message on a fatal error, never raw HTML', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const h = harness([root]);
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(new Response('boom', { status: 500 }));
    await flush();

    assert.equal(root.textContent, COMPONENT_BLOCKED_MESSAGE);
    assert.equal(h.morphs.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('disposeAll removes listeners, clears bindings, and drops the marker', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');

    h.bindings.disposeAll();

    assert.equal(h.bindings.size, 0);
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), null);
    assert.equal(h.doc.listeners.get('click')?.length ?? 0, 0);
  });

  it('collectRemoved disposes a binding whose root is disconnected', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();

    root.isConnected = false;
    h.bindings.collectRemoved();

    assert.equal(h.bindings.size, 0);
  });

  it('rebinds a fresh root after disposeAll', () => {
    const root = componentRoot('counter-1');
    const h = harness([root]);
    h.bindings.mountAll();
    h.bindings.disposeAll();

    h.bindings.mountAll();
    assert.equal(h.bindings.size, 1);
    assert.equal(root.getAttribute(ISLAND_HYDRATED_ATTRIBUTE), 'true');
  });
});

// ---------------------------------------------------------------------------
// Nested island hooks
// ---------------------------------------------------------------------------

describe('nested island hooks', () => {
  it('tears down nested islands before the morph and remounts after', async () => {
    const root = componentRoot('counter-1');
    const trigger = append(root, fakeElement('button', { [CALL_ATTRIBUTE]: 'save' }));
    const calls: string[] = [];
    const islands: IslandManager = {
      registry: new Map(),
      mountAll: () => {},
      mountWithin: () => {
        calls.push('mountWithin');
      },
      unmountNonPermanent: () => {},
      collectRemoved: () => {},
      beforeMorph: () => {
        calls.push('beforeMorph');
        return () => {
          calls.push('restore');
        };
      },
      afterMorph: () => {},
    };
    const h = harness([root], { islands });
    h.bindings.mountAll();

    dispatch(h.doc, fakeEvent('click', trigger));
    h.resolveNext(successResponse(1, { title: 'hello', count: 0 }));
    await flush();

    assert.deepEqual(calls, ['beforeMorph', 'restore', 'mountWithin']);
  });
});
