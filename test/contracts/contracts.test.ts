import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createElement } from 'preact';

import { SERVER_ONLY } from '../../src/contracts/component.js';
import type {
  Component,
  IntrinsicElement,
  RenderChild,
  VNode,
} from '../../src/contracts/component.js';
import type {
  JsonObject,
  JsonValue,
  RequestContext,
  Session,
  SessionStore,
} from '../../src/contracts/http.js';
import type { PageModule } from '../../src/contracts/render.js';

/** Working in-memory SessionStore adapter; not a stub, it really stores. */
function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, Session>();
  return {
    async get(id) {
      return sessions.get(id) ?? null;
    },
    async set(session) {
      sessions.set(session.id, session);
    },
    async delete(id) {
      sessions.delete(id);
    },
  };
}

function makeContext(session: Session | null, params: Record<string, string> = {}): RequestContext {
  const request = new Request('https://example.com/posts/42', { method: 'GET' });
  return { request, url: new URL(request.url), params, session };
}

const SESSION: Session = {
  id: 'sess_1',
  csrfToken: 'csrf_1',
  data: { userId: 'u1' },
  expiresAt: 2_000_000_000_000,
};

describe('json and http contracts', () => {
  it('accepts representative JSON values', () => {
    const value: JsonValue = { list: [1, 'two', null, true], nested: { ok: false } };
    const object: JsonObject = { userId: 'u1', count: 3, active: true };
    assert.deepEqual(value, { list: [1, 'two', null, true], nested: { ok: false } });
    assert.deepEqual(object, { userId: 'u1', count: 3, active: true });
  });

  it('round-trips a session through a SessionStore', async () => {
    const store = createMemorySessionStore();
    await store.set(SESSION);
    assert.deepEqual(await store.get('sess_1'), SESSION);
    assert.equal(await store.get('missing'), null);
    await store.delete('sess_1');
    assert.equal(await store.get('sess_1'), null);
  });

  it('shapes a RequestContext with and without a session', () => {
    const authed = makeContext(SESSION, { id: '42' });
    const anon = makeContext(null);

    assert.equal(authed.url.pathname, '/posts/42');
    assert.equal(authed.params.id, '42');
    assert.equal(authed.session?.id, 'sess_1');
    assert.equal(anon.session, null);
    assert.equal(anon.request.method, 'GET');
  });
});

describe('component contracts', () => {
  it('represents an intrinsic VNode produced by createElement', () => {
    const tag: IntrinsicElement = 'h1';
    const node: VNode = createElement(tag, null, 'Hello');
    assert.equal(node.type, 'h1');
    assert.equal(node.props.children, 'Hello');
  });

  it('renders a sync function component', () => {
    const Greeting: Component<{ name: string }> = (props) =>
      createElement('h1', null, `Hello ${props.name}`);

    const node = Greeting({ name: 'Ada' }) as VNode;
    assert.equal(node.type, 'h1');
    assert.equal(node.props.children, 'Hello Ada');
  });

  it('accepts arrays, text, and empty render children', () => {
    const children: RenderChild[] = ['a', 1, null, false, createElement('span', null)];
    assert.equal(children.length, 5);
    assert.equal(children[0], 'a');
  });

  it('marks a server-only component and rejects nothing statically itself', () => {
    const Dashboard: Component = () => createElement('aside', null);
    Dashboard[SERVER_ONLY] = true;

    assert.equal(typeof SERVER_ONLY, 'symbol');
    assert.equal(Dashboard[SERVER_ONLY], true);
  });
});

describe('page contracts', () => {
  it('types a filesystem page module', async () => {
    interface Post {
      title: string;
      body: string;
    }

    const postPage: PageModule<{ post: Post }> = {
      async load(context) {
        return { post: { title: `Post ${context.params.id ?? ''}`, body: 'body' } };
      },
      async getStaticPaths() {
        return [{ id: '1' }, { id: '2' }];
      },
      default(props) {
        const node: VNode = createElement('article', null, props.post.title);
        return node;
      },
    };

    const ctx = makeContext(null, { id: '42' });
    const loaded = await postPage.load!(ctx);
    assert.equal(loaded.post.title, 'Post 42');

    const paths = await postPage.getStaticPaths!();
    assert.equal(paths.length, 2);

    const rendered = postPage.default({ post: { title: 'Static', body: 'b' } }) as VNode;
    assert.equal(rendered.type, 'article');
  });
});
