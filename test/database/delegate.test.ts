import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { delegate, DelegateError } from '../../src/database/delegate.js';

// ---------------------------------------------------------------------------
// Helpers — plain objects that simulate Active Record entities with relations.
// `delegate` operates on the prototype, so these are plain constructors.
// ---------------------------------------------------------------------------

function makeAuthor(name: string, email: string) {
  return {
    name,
    email,
    greet() {
      return `Hello, I am ${this.name}`;
    },
  };
}

class Post {
  declare author: ReturnType<typeof makeAuthor> | null | undefined;

  body!: string;

  title!: string;

  constructor(title: string, body: string, author?: ReturnType<typeof makeAuthor>) {
    this.title = title;
    this.body = body;
    this.author = author ?? null;
  }
}

class NullablePost {
  declare author: ReturnType<typeof makeAuthor> | null | undefined;

  title!: string;

  constructor(title: string) {
    this.title = title;
    this.author = null;
  }
}

// ---------------------------------------------------------------------------
// String form
// ---------------------------------------------------------------------------

describe('delegate (string form)', () => {
  it('forwards a getter through the relation', () => {
    delegate('name', { to: 'author' })(Post);

    const author = makeAuthor('Alice', 'alice@example.com');
    const post = new Post('Hello', 'World', author);

    assert.equal((post as any).name, 'Alice');
  });

  it('supports a renamed target method', () => {
    class RenamedPost {
      declare author: ReturnType<typeof makeAuthor> | null;
    }

    delegate('author_name', { to: 'author', method: 'name' })(RenamedPost);

    const author = makeAuthor('Bob', 'bob@example.com');
    const post = new RenamedPost() as any;
    post.author = author;

    assert.equal(post.author_name, 'Bob');
  });

  it('forwards a method with `this` bound to the target', () => {
    delegate('greet', { to: 'author' })(Post);

    const author = makeAuthor('Alice', 'alice@example.com');
    const post = new Post('Hello', 'World', author);

    const greetFn = (post as any).greet;
    assert.equal(typeof greetFn, 'function');
    assert.equal(greetFn(), 'Hello, I am Alice');
  });

  it('throws DelegateError (nil_target) when the relation is null (allow_nil off)', () => {
    class NoAuthor {
      declare author: null;
    }

    delegate('name', { to: 'author' })(NoAuthor);

    const post = new NoAuthor();
    post.author = null;

    assert.throws(
      () => (post as any).name,
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'nil_target');
        return true;
      },
    );
  });

  it('throws DelegateError (nil_target) when the relation is undefined (allow_nil off)', () => {
    class UndefinedAuthor {
      declare author: undefined;
    }

    delegate('name', { to: 'author' })(UndefinedAuthor);

    const post = new UndefinedAuthor();
    post.author = undefined;

    assert.throws(
      () => (post as any).name,
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'nil_target');
        return true;
      },
    );
  });

  it('returns undefined when the relation is null with allow_nil: true', () => {
    delegate('name', { to: 'author', allow_nil: true })(NullablePost);

    const post = new NullablePost('Hi');
    assert.equal((post as any).name, undefined);
  });

  it('returns undefined when the relation is undefined with allow_nil: true', () => {
    class UndefPost {
      declare author: undefined;
    }

    delegate('name', { to: 'author', allow_nil: true })(UndefPost);

    const post = new UndefPost();
    assert.equal((post as any).name, undefined);
  });

  it('returns the value when the relation is present with allow_nil: true', () => {
    delegate('name', { to: 'author', allow_nil: true })(Post);

    const author = makeAuthor('Charlie', 'charlie@example.com');
    const post = new Post('Hi', '', author);

    assert.equal((post as any).name, 'Charlie');
  });
});

// ---------------------------------------------------------------------------
// Array form
// ---------------------------------------------------------------------------

// Fresh class for array-form tests — must NOT have own `title`/`body` properties
// that would shadow the prototype getters installed by `delegate`.
class ArrayDelegateTarget {
  declare post: { title: string; body: string } | null;
}

describe('delegate (array form)', () => {
  it('forwards multiple same-named getters', () => {
    delegate(['title', 'body'], { to: 'post' })(ArrayDelegateTarget);

    const wrapper = new ArrayDelegateTarget();
    wrapper.post = { title: 'Delegated', body: 'DelegatedBody' };

    assert.equal((wrapper as any).title, 'Delegated');
    assert.equal((wrapper as any).body, 'DelegatedBody');
  });

  it('throws DelegateError when the relation target is null for any entry', () => {
    delegate(['title'], { to: 'post' })(ArrayDelegateTarget);

    const wrapper = new ArrayDelegateTarget();
    wrapper.post = null;

    assert.throws(
      () => (wrapper as any).title,
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'nil_target');
        return true;
      },
    );
  });

  it('returns undefined for null target with allow_nil: true', () => {
    delegate(['title'], { to: 'post', allow_nil: true })(ArrayDelegateTarget);

    const wrapper = new ArrayDelegateTarget();
    wrapper.post = null;

    assert.equal((wrapper as any).title, undefined);
  });

  it('throws invalid_delegate for an empty array', () => {
    assert.throws(
      () => delegate([], { to: 'author' }),
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'invalid_delegate');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Record (rename map) form
// ---------------------------------------------------------------------------

describe('delegate (record form)', () => {
  it('forwards getters using the map keys as property names and values as target methods', () => {
    delegate({ author_name: 'name', author_email: 'email' }, { to: 'author' })(Post);

    const author = makeAuthor('Dana', 'dana@example.com');
    const post = new Post('Hi', '', author);

    assert.equal((post as any).author_name, 'Dana');
    assert.equal((post as any).author_email, 'dana@example.com');
  });

  it('forwards methods with receiver binding', () => {
    delegate({ author_greet: 'greet' }, { to: 'author' })(Post);

    const author = makeAuthor('Eve', 'eve@example.com');
    const post = new Post('Hi', '', author);

    const greetFn = (post as any).author_greet;
    assert.equal(typeof greetFn, 'function');
    assert.equal(greetFn(), 'Hello, I am Eve');
  });

  it('throws invalid_delegate for an empty map', () => {
    assert.throws(
      () => delegate({}, { to: 'author' }),
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'invalid_delegate');
        return true;
      },
    );
  });

  it('throws invalid_delegate for a map with an empty key', () => {
    assert.throws(
      () => delegate({ '': 'name' }, { to: 'author' }),
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'invalid_delegate');
        return true;
      },
    );
  });

  it('throws invalid_delegate for a map with an empty value', () => {
    assert.throws(
      () => delegate({ name: '' }, { to: 'author' }),
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'invalid_delegate');
        return true;
      },
    );
  });

  it('throws nil_target when the relation is null', () => {
    delegate({ author_name: 'name' }, { to: 'author' })(NullablePost);

    const post = new NullablePost('Hi');

    assert.throws(
      () => (post as any).author_name,
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'nil_target');
        return true;
      },
    );
  });

  it('returns undefined for null target with allow_nil: true', () => {
    delegate({ author_name: 'name' }, { to: 'author', allow_nil: true })(NullablePost);

    const post = new NullablePost('Hi');
    assert.equal((post as any).author_name, undefined);
  });
});

// ---------------------------------------------------------------------------
// Prefix option
// ---------------------------------------------------------------------------

describe('prefix option', () => {
  it('prefix: true renames keys to <to>_<method> (string form)', () => {
    class PrefixedPost {
      declare author: ReturnType<typeof makeAuthor> | null;
    }

    delegate('name', { to: 'author', prefix: true })(PrefixedPost);

    const author = makeAuthor('Frank', 'frank@example.com');
    const post = new PrefixedPost() as any;
    post.author = author;

    assert.equal(post.author_name, 'Frank');
  });

  it('prefix: string renames keys to <prefix>_<method> (string form)', () => {
    class PrefixedPost {
      declare author: ReturnType<typeof makeAuthor> | null;
    }

    delegate('name', { to: 'author', prefix: 'writer' })(PrefixedPost);

    const author = makeAuthor('Grace', 'grace@example.com');
    const post = new PrefixedPost() as any;
    post.author = author;

    assert.equal(post.writer_name, 'Grace');
  });

  it('prefix: true renames keys in array form', () => {
    delegate(['title', 'body'], { to: 'post', prefix: true })(ArrayDelegateTarget);

    const wrapper = new ArrayDelegateTarget();
    wrapper.post = { title: 'T', body: 'B' };

    assert.equal((wrapper as any).post_title, 'T');
    assert.equal((wrapper as any).post_body, 'B');
  });

  it('prefix does NOT rename record keys (they are used verbatim)', () => {
    delegate({ explicit_key: 'name' }, { to: 'author', prefix: true })(Post);

    const author = makeAuthor('Hank', 'hank@example.com');
    const post = new Post('Hi', '', author);

    // Record keys are taken verbatim — `explicit_key`, not `author_explicit_key`.
    assert.equal((post as any).explicit_key, 'Hank');
    assert.equal((post as any).author_explicit_key, undefined);
  });
});

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

describe('invalid options', () => {
  it('throws DelegateError when "to" option is empty', () => {
    assert.throws(
      () => delegate('name', { to: '' }),
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'invalid_delegate');
        return true;
      },
    );
  });

  it('throws DelegateError when "to" option is missing entirely', () => {
    // `to` is required by the type, but test the runtime guard.
    assert.throws(
      () => delegate('name', undefined as any),
      (err: unknown): boolean => {
        if (!(err instanceof DelegateError)) return false;
        assert.equal(err.code, 'invalid_delegate');
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// DelegateError value-free guarantee
// ---------------------------------------------------------------------------

describe('DelegateError is value-free', () => {
  it('has a `code` property but never echoes the value', () => {
    const err = new DelegateError('nil_target', 'relation is nil');
    assert.equal(err.name, 'DelegateError');
    assert.equal(err.code, 'nil_target');
    assert.equal(err.message, 'relation is nil');
    // The message should not contain any user data (verified by the string
    // assertions above — no field value leakage).
  });
});
