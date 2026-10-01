import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSync } from 'rolldown/utils';

import { DiagnosticBag } from '../../src/compiler/diagnostics.js';
import { parseTemplate } from '../../src/compiler/template-ast.js';
import { lowerTemplate } from '../../src/compiler/template-lower.js';

function lower(source: string): { jsx: string; bag: DiagnosticBag } {
  const bag = new DiagnosticBag({ source, frames: false });
  const ctx = { bag, baseOffset: 0 };
  const jsx = lowerTemplate(
    parseTemplate(source, () => {}),
    ctx,
  );
  return { jsx, bag };
}

/** Assert the lowered JSX parses as valid TSX when embedded in a fragment. */
function assertValidTsx(jsx: string): void {
  const result = parseSync('probe.tsx', `const x = () => (<>${jsx}</>);\n`, {
    sourceType: 'module',
  });
  const errors = result.errors.filter((error) => error.severity === 'Error');
  assert.equal(errors.length, 0, `emitted JSX did not parse: ${jsx}`);
}

test('lowers text and interpolation', () => {
  const { jsx, bag } = lower('<p>hi {name}</p>');
  assert.equal(jsx, '<p>hi {name}</p>');
  assert.equal(bag.hasErrors, false);
});

test('lowers a self-closing element', () => {
  const { jsx } = lower('<br />');
  assert.equal(jsx, '<br />');
});

test('lowers js-if to a ternary with a null fallback', () => {
  const { jsx, bag } = lower('<p js-if="ok">yes</p>');
  assert.equal(jsx, '{ok ? (<p>yes</p>) : null}');
  assert.equal(bag.hasErrors, false);
  assertValidTsx(jsx);
});

test('lowers a js-if/js-else-if/js-else chain', () => {
  const { jsx } = lower('<p js-if="a">A</p><p js-else-if="b">B</p><p js-else>C</p>');
  assert.equal(jsx, '{a ? (<p>A</p>) : b ? (<p>B</p>) : (<p>C</p>)}');
  assertValidTsx(jsx);
});

test('reports unsupported_position for js-else without js-if and continues siblings', () => {
  const { jsx, bag } = lower('<p js-else>x</p><span>keep</span>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  assert.equal(list[0]!.message, "Directive 'js-else' has no preceding js-if");
  // The stray js-else is lowered as ordinary element; sibling should survive.
  assert.ok(jsx.includes('<span>keep</span>'), 'sibling should survive');
});

test('lowers js-for to a map', () => {
  const { jsx } = lower('<li js-for="item in items">{item}</li>');
  assert.equal(jsx, '{items.map((item) => (<li>{item}</li>))}');
  assertValidTsx(jsx);
});

test('lowers js-for with js-if inside the loop', () => {
  const { jsx } = lower('<li js-for="item in items" js-if="item.ok">{item}</li>');
  assert.equal(jsx, '{items.map((item) => (item.ok ? (<li>{item}</li>) : null))}');
  assertValidTsx(jsx);
});

test('lowers js-for with an index binding', () => {
  const { jsx } = lower('<li js-for="(item, index) in items">{item}</li>');
  assert.equal(jsx, '{items.map((item, index) => (<li>{item}</li>))}');
  assertValidTsx(jsx);
});

test('lowers js-for with an index and key binding', () => {
  const { jsx } = lower('<li js-for="(item, index, key) in items">{item}</li>');
  assert.equal(jsx, '{items.map((item, index, key) => (<li>{item}</li>))}');
  assertValidTsx(jsx);
});

test('lowers js-for with an object destructuring binding', () => {
  const { jsx } = lower('<li js-for="{ id, name } in items">{name}</li>');
  assert.equal(jsx, '{items.map(({ id, name }) => (<li>{name}</li>))}');
  assertValidTsx(jsx);
});

test('lowers js-for with an array destructuring binding', () => {
  const { jsx } = lower('<li js-for="[a, b] in pairs">{a}</li>');
  assert.equal(jsx, '{pairs.map(([a, b]) => (<li>{a}</li>))}');
  assertValidTsx(jsx);
});

test('lowers js-for with a rest element in the binding', () => {
  const { jsx } = lower('<li js-for="{ id, ...rest } in items">{id}</li>');
  assert.equal(jsx, '{items.map(({ id, ...rest }) => (<li>{id}</li>))}');
  assertValidTsx(jsx);
});

test('lowers js-for destructuring with js-if inside the loop', () => {
  const { jsx } = lower('<li js-for="{ id } in items" js-if="id">{id}</li>');
  assert.equal(jsx, '{items.map(({ id }) => (id ? (<li>{id}</li>) : null))}');
  assertValidTsx(jsx);
});

test('lowers js-for with the index used in the body', () => {
  const { jsx } = lower('<li js-for="(item, i) in items">{i}</li>');
  assert.equal(jsx, '{items.map((item, i) => (<li>{i}</li>))}');
  assertValidTsx(jsx);
});

test('reports unsupported_position for a malformed js-for and emits placeholder', () => {
  const { jsx, bag } = lower('<li js-for="items">x</li>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  assert.ok(list[0]!.message.includes('Malformed js-for'));
  assert.equal(jsx, '{null}');
});

test('reports unsupported_position for an unbalanced js-for binding', () => {
  const { jsx, bag } = lower('<li js-for="(item in items">x</li>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  assert.equal(jsx, '{null}');
});

test('reports unsupported_position for an empty js-for binding', () => {
  const { jsx, bag } = lower('<li js-for=" in items">x</li>');
  assert.equal(bag.hasErrors, true);
  assert.equal(jsx, '{null}');
});

test('lowers js-bind to an attribute binding', () => {
  const { jsx } = lower('<a js-bind:href="url">x</a>');
  assert.equal(jsx, '<a href={url}>x</a>');
});

test('lowers js-on to an event binding', () => {
  const { jsx } = lower('<button js-on:click="go">x</button>');
  assert.equal(jsx, '<button onClick={go}>x</button>');
});

test('lowers js-model to a bind spread', () => {
  const { jsx } = lower('<input js-model="title" />');
  assert.equal(jsx, "<input {...bind('title')} />");
});

test('reports unsupported_position for js-model on a component, continues siblings', () => {
  const { jsx, bag } = lower('<Child js-model="title" /><span>ok</span>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  assert.equal(list[0]!.message, "Directive 'js-model' is not supported on a component");
  // The component falls back to a self-closing literal tag with remaining attrs.
  assert.ok(jsx.includes('<Child'), 'should fall back to literal tag');
  assert.ok(jsx.includes('<span>ok</span>'), 'sibling should survive');
});

test('lowers js-submit to a submit spread', () => {
  const { jsx } = lower('<form js-submit="add">x</form>');
  assert.equal(jsx, "<form {...submit('add')}>x</form>");
});

test('lowers a valueless js-ignore', () => {
  const { jsx } = lower('<div js-ignore>x</div>');
  assert.equal(jsx, '<div {...ignore()}>x</div>');
  assertValidTsx(jsx);
});

test('lowers js-visible to a display style', () => {
  const { jsx } = lower('<div js-visible="open">x</div>');
  assert.equal(jsx, "<div style={{ display: open ? undefined : 'none' }}>x</div>");
  assertValidTsx(jsx);
});

test('lowers js-content to a sole interpolated child', () => {
  const { jsx } = lower('<p js-content="name" />');
  assert.equal(jsx, '<p>{name}</p>');
  assertValidTsx(jsx);
});

test('reports unsupported_position for js-content combined with children', () => {
  const { jsx, bag } = lower('<p js-content="name">x</p>');
  assert.equal(bag.hasErrors, true);
  // js-content with children emits an error and keeps the js-content child,
  // dropping the literal children so the emitted JSX stays valid.
  assert.equal(jsx, '<p>{name}</p>');
  assertValidTsx(jsx);
});

test('lowers js-once to a marker on a plain element', () => {
  const { jsx } = lower('<div js-once>x</div>');
  assert.equal(jsx, '<div data-jsails-once="">x</div>');
  assertValidTsx(jsx);
});

test('reports unsupported_position for js-once with a value', () => {
  const { jsx, bag } = lower('<div js-once="x">y</div>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  // The js-once attr is dropped.
  assert.ok(!jsx.includes('data-jsails-once'), 'js-once attr should be dropped');
});

test('lowers js-pre to a raw subtree (no interpolation, no directive lowering)', () => {
  const { jsx } = lower('<div js-pre><span>{{ raw }}</span></div>');
  assert.equal(jsx, '<div><span>{{raw}}</span></div>');
  assertValidTsx(jsx);
});

test('reports unknown_directive for an unknown js-* directive and drops the attr', () => {
  const { jsx, bag } = lower('<p js-frob="x">y</p>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unknown_directive');
  // The bad attribute is dropped, the element survives.
  assert.ok(jsx.includes('<p'), 'element should survive');
  assert.ok(jsx.includes('>y</p>'), 'children should survive');
  assert.ok(!jsx.includes('js-frob'), 'bad attr should be dropped');
});

test('preserves a plain quoted attribute', () => {
  const { jsx } = lower('<div class="card">x</div>');
  assert.equal(jsx, '<div class="card">x</div>');
});

test('preserves a bare attribute', () => {
  const { jsx } = lower('<input disabled />');
  assert.equal(jsx, '<input disabled />');
});

test('lowers a brace-valued plain attribute', () => {
  const { jsx } = lower('<div data-x={v}>y</div>');
  assert.equal(jsx, '<div data-x={v}>y</div>');
});

test('lowers a dynamic component to an h call', () => {
  const { jsx } = lower('<component js-is="X" />');
  assert.equal(jsx, '{h(X, {})}');
  assertValidTsx(jsx);
});

test('lowers a dynamic component with attributes', () => {
  const { jsx } = lower('<component js-is="X" class="a" />');
  assert.equal(jsx, "{h(X, { class: 'a' })}");
  assertValidTsx(jsx);
});

test('lowers a dynamic component with children', () => {
  const { jsx } = lower('<component js-is="X"><span>hi</span></component>');
  assert.equal(jsx, '{h(X, {}, <span>hi</span>)}');
  assertValidTsx(jsx);
});

test('lowers a dynamic component with an event binding', () => {
  const { jsx } = lower('<component js-is="X" js-on:click="go" />');
  assert.equal(jsx, '{h(X, { onClick: go })}');
  assertValidTsx(jsx);
});

test('lowers a dynamic component with a js-bind attribute', () => {
  const { jsx } = lower('<component js-is="X" js-bind:title="label" />');
  assert.equal(jsx, '{h(X, { title: label })}');
  assertValidTsx(jsx);
});

test('reports unsupported_position for a component tag without js-is, falls back to literal', () => {
  const { jsx, bag } = lower('<component>x</component>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  // Recovery: falls back to rendering as a literal <component /> tag.
  assert.match(jsx, /<component/);
});

test('reports unsupported_position for a js-* directive on a dynamic component and skips the attr', () => {
  const { jsx, bag } = lower('<component js-is="X" js-model="title" />');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  // The js-model attr is skipped, the component still renders.
  assert.ok(jsx.includes('h(X,'), 'h call should survive');
});

test('lowers js-html to dangerouslySetInnerHTML', () => {
  const { jsx } = lower('<div js-html="html" />');
  assert.equal(jsx, '<div dangerouslySetInnerHTML={{ __html: html }} />');
  assertValidTsx(jsx);
});

test('reports unsupported_position for js-html combined with children', () => {
  const { jsx, bag } = lower('<div js-html="html">x</div>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  // Recovery: the directive survives, the children are dropped so the emitted
  // JSX stays valid (no children alongside dangerouslySetInnerHTML).
  assert.equal(jsx, '<div dangerouslySetInnerHTML={{ __html: html }} />');
  assertValidTsx(jsx);
});

test('lowers the .once event modifier to a marker', () => {
  const { jsx } = lower('<button js-on:click.once="go">x</button>');
  assert.equal(jsx, '<button onClick={go} data-jsails-once="">x</button>');
  assertValidTsx(jsx);
});

test('lowers the .capture event modifier to a marker', () => {
  const { jsx } = lower('<form js-on:submit.capture="save">x</form>');
  assert.equal(jsx, '<form onSubmit={save} data-jsails-capture="">x</form>');
  assertValidTsx(jsx);
});

test('lowers the .passive event modifier to a marker', () => {
  const { jsx } = lower('<input js-on:input.passive="onInput" />');
  assert.equal(jsx, '<input onInput={onInput} data-jsails-passive="" />');
  assertValidTsx(jsx);
});

test('lowers the .prevent event modifier to an inline guard', () => {
  const { jsx } = lower('<form js-on:submit.prevent="save">x</form>');
  assert.equal(jsx, '<form onSubmit={(e) => { e.preventDefault(); save(e); }}>x</form>');
  assertValidTsx(jsx);
});

test('lowers the .stop event modifier to an inline guard', () => {
  const { jsx } = lower('<button js-on:click.stop="go">x</button>');
  assert.equal(jsx, '<button onClick={(e) => { e.stopPropagation(); go(e); }}>x</button>');
  assertValidTsx(jsx);
});

test('lowers the .self event modifier to an inline guard', () => {
  const { jsx } = lower('<button js-on:click.self="go">x</button>');
  assert.equal(
    jsx,
    '<button onClick={(e) => { if (e.target !== e.currentTarget) return; go(e); }}>x</button>',
  );
  assertValidTsx(jsx);
});

test('lowers multiple event modifiers to multiple markers', () => {
  const { jsx } = lower('<button js-on:click.once.capture.passive="go">x</button>');
  assert.equal(
    jsx,
    '<button onClick={go} data-jsails-once="" data-jsails-capture="" data-jsails-passive="">x</button>',
  );
  assertValidTsx(jsx);
});

test('reports unknown_directive for an unknown event modifier, drops the attr', () => {
  const { jsx, bag } = lower('<button js-on:click.frob="go">x</button>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.ok(list.length >= 1);
  const err = list.find((d) => d.code === 'unknown_directive');
  assert.ok(err !== undefined, 'should have unknown_directive error');
  assert.ok(err.message.includes(".frob'"), 'message should name the modifier');
  // The entire js-on attr is dropped because the modifier is unrecognized.
  assert.ok(!jsx.includes('onClick'), 'bad event attr should be dropped');
});

test('reports unknown_directive for the .camel modifier', () => {
  const { bag } = lower('<button js-on:click.camel="go">x</button>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.ok(list.some((d) => d.code === 'unknown_directive'));
});

test('reports unknown_directive for the .prop modifier', () => {
  const { bag } = lower('<button js-on:click.prop="go">x</button>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.ok(list.some((d) => d.code === 'unknown_directive'));
});

test('lowers an event modifier on a dynamic component', () => {
  const { jsx } = lower('<component js-is="X" js-on:click.once="go" />');
  assert.equal(jsx, "{h(X, { onClick: go, 'data-jsails-once': '' })}");
  assertValidTsx(jsx);
});

test('stray js-else alongside a valid sibling: error reported, sibling survives', () => {
  const { jsx, bag } = lower('<p js-else>x</p><div>keep</div>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  assert.equal(list[0]!.message, "Directive 'js-else' has no preceding js-if");
  assert.ok(jsx.includes('<div>keep</div>'), 'sibling should survive');
});

test('unknown modifier drops only that attr, sibling attrs survive', () => {
  const { jsx, bag } = lower('<button class="btn" js-on:click.frob="go" id="x">y</button>');
  assert.equal(bag.hasErrors, true);
  // The js-on:click.frob attr is dropped; class and id survive.
  assert.ok(jsx.includes('class="btn"'), 'class attr should survive');
  assert.ok(jsx.includes('id="x"'), 'id attr should survive');
  assert.ok(jsx.includes('>y</button>'), 'children should survive');
});

test('<component> without js-is falls back to literal tag and reports error', () => {
  const { jsx, bag } = lower('<component class="a"><span>hi</span></component>');
  assert.equal(bag.hasErrors, true);
  const list = bag.toList();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.code, 'unsupported_position');
  // Falls back to a self-closing literal tag.
  assert.ok(jsx.includes('<component'), 'should fall back to literal tag');
});

test('malformed js-for does not prevent sibling from lowering', () => {
  const { jsx, bag } = lower('<li js-for="items">bad</li><li>good</li>');
  assert.equal(bag.hasErrors, true);
  assert.equal(jsx, '{null}<li>good</li>');
});
