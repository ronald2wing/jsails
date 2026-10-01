import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  Num,
  NumError,
  format,
  compact,
  currency,
  percent,
  unit,
  bytes,
  ordinal,
  clamp,
  round,
  parse,
  money,
  formatMoney,
} from '../../src/support/numbers.js';
import { add, subtract, compare, toSnapshot } from 'dinero.js';

// ---------------------------------------------------------------------------
// format
// ---------------------------------------------------------------------------

describe('Num.format', () => {
  it('formats with default locale', () => {
    const result = format(1234.56);
    assert.equal(result, '1,234.56');
  });

  it('formats with a specific locale', () => {
    const result = format(1234.56, undefined, 'de-DE');
    assert.equal(result, '1.234,56');
  });

  it('formats with custom options', () => {
    const result = format(42, { minimumIntegerDigits: 3 });
    assert.equal(result, '042');
  });

  it('throws NumError for non-number', () => {
    assert.throws(() => format(NaN), NumError);
    assert.throws(() => format(Infinity), NumError);
    assert.throws(() => format('42' as unknown as number), NumError);
  });

  it('message never echoes the input', () => {
    try {
      format(NaN);
    } catch (e) {
      assert.ok(e instanceof NumError);
      assert.ok(!e.message.includes('NaN'));
    }
  });
});

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

describe('Num.compact', () => {
  it('renders thousands', () => {
    const result = compact(1500);
    assert.equal(result, '1.5K');
  });

  it('renders millions', () => {
    const result = compact(2_500_000);
    assert.equal(result, '2.5M');
  });

  it('renders zero', () => {
    assert.equal(compact(0), '0');
  });

  it('throws NumError for non-finite input', () => {
    assert.throws(() => compact(NaN), NumError);
    assert.throws(() => compact(Infinity), NumError);
  });
});

// ---------------------------------------------------------------------------
// currency
// ---------------------------------------------------------------------------

describe('Num.currency', () => {
  it('formats USD with default locale', () => {
    const result = currency(12.99, 'USD');
    assert.equal(result, '$12.99');
  });

  it('formats EUR with locale', () => {
    const result = currency(1234.56, 'EUR', 'de-DE');
    assert.ok(result.includes('1.234,56'));
  });

  it('throws NumError for non-number', () => {
    assert.throws(() => currency(NaN, 'USD'), NumError);
  });
});

// ---------------------------------------------------------------------------
// percent
// ---------------------------------------------------------------------------

describe('Num.percent', () => {
  it('formats a decimal as percent', () => {
    const result = percent(0.25);
    assert.equal(result, '25%');
  });

  it('formats with custom options', () => {
    const result = percent(0.1234, { minimumFractionDigits: 2 });
    assert.equal(result, '12.34%');
  });

  it('throws NumError for NaN', () => {
    assert.throws(() => percent(NaN), NumError);
  });
});

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------

describe('Num.unit', () => {
  it('formats a unit value', () => {
    const result = unit(5, 'kilometer');
    assert.equal(result, '5 km');
  });

  it('throws NumError for non-number', () => {
    assert.throws(() => unit(NaN, 'kilometer'), NumError);
  });
});

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

describe('Num.bytes', () => {
  it('formats bytes', () => {
    assert.equal(bytes(0), '0 B');
    assert.equal(bytes(1024), '1.02 kB');
    assert.equal(bytes(1_048_576), '1.05 MB');
  });

  it('formats with binary option', () => {
    const result = bytes(1536, { binary: true });
    assert.equal(result, '1.5 KiB');
  });

  it('handles negative (edge case)', () => {
    assert.equal(bytes(-1024), '-1.02 kB');
  });

  it('throws NumError for non-finite input', () => {
    assert.throws(() => bytes(NaN), NumError);
    assert.throws(() => bytes(Infinity), NumError);
  });
});

// ---------------------------------------------------------------------------
// ordinal
// ---------------------------------------------------------------------------

describe('Num.ordinal', () => {
  it('formats English ordinals', () => {
    assert.equal(ordinal(1), '1st');
    assert.equal(ordinal(2), '2nd');
    assert.equal(ordinal(3), '3rd');
    assert.equal(ordinal(4), '4th');
    assert.equal(ordinal(11), '11th');
    assert.equal(ordinal(12), '12th');
    assert.equal(ordinal(13), '13th');
    assert.equal(ordinal(21), '21st');
    assert.equal(ordinal(22), '22nd');
    assert.equal(ordinal(23), '23rd');
  });

  it('handles zero', () => {
    assert.equal(ordinal(0), '0th');
  });

  it('handles large numbers', () => {
    assert.ok(ordinal(101).endsWith('st'));
    assert.ok(ordinal(102).endsWith('nd'));
    assert.ok(ordinal(103).endsWith('rd'));
    assert.ok(ordinal(111).endsWith('th'));
  });

  it('throws NumError for non-integer', () => {
    assert.throws(() => ordinal(1.5), NumError);
  });

  it('throws NumError for NaN', () => {
    assert.throws(() => ordinal(NaN), NumError);
  });
});

// ---------------------------------------------------------------------------
// clamp
// ---------------------------------------------------------------------------

describe('Num.clamp', () => {
  it('clamps a value in range', () => {
    assert.equal(clamp(5, 1, 10), 5);
    assert.equal(clamp(0, 1, 10), 1);
    assert.equal(clamp(15, 1, 10), 10);
  });

  it('clamps at boundaries', () => {
    assert.equal(clamp(1, 1, 10), 1);
    assert.equal(clamp(10, 1, 10), 10);
  });

  it('handles negative ranges', () => {
    assert.equal(clamp(-5, -10, -1), -5);
    assert.equal(clamp(-20, -10, -1), -10);
    assert.equal(clamp(0, -10, -1), -1);
  });

  it('handles zero', () => {
    assert.equal(clamp(0, -5, 5), 0);
  });

  it('throws when min > max', () => {
    assert.throws(() => clamp(5, 10, 1), NumError);
  });

  it('throws NumError for non-finite input', () => {
    assert.throws(() => clamp(NaN, 1, 10), NumError);
    assert.throws(() => clamp(5, NaN, 10), NumError);
    assert.throws(() => clamp(5, 1, NaN), NumError);
  });
});

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

describe('Num.round', () => {
  it('rounds with default precision 0', () => {
    assert.equal(round(3.14), 3);
    assert.equal(round(3.6), 4);
  });

  it('rounds with specified precision', () => {
    assert.equal(round(3.14159, 2), 3.14);
    assert.equal(round(3.14159, 3), 3.142);
    assert.equal(round(3.14159, 0), 3);
  });

  it('handles negative numbers', () => {
    assert.equal(round(-3.14159, 2), -3.14);
    assert.equal(round(-3.6), -4);
  });

  it('handles zero', () => {
    assert.equal(round(0, 2), 0);
  });

  it('throws for negative precision', () => {
    assert.throws(() => round(3.14, -1), NumError);
  });

  it('throws for non-integer precision', () => {
    assert.throws(() => round(3.14, 1.5), NumError);
  });

  it('throws NumError for NaN', () => {
    assert.throws(() => round(NaN), NumError);
  });
});

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

describe('Num.parse', () => {
  it('parses a valid string', () => {
    assert.equal(parse('42'), 42);
    assert.equal(parse('3.14'), 3.14);
    assert.equal(parse('-10'), -10);
  });

  it('trims whitespace', () => {
    assert.equal(parse('  42  '), 42);
  });

  it('parses zero', () => {
    assert.equal(parse('0'), 0);
  });

  it('throws for empty string', () => {
    assert.throws(() => parse(''), NumError);
    assert.throws(() => parse('   '), NumError);
  });

  it('throws for non-numeric string', () => {
    assert.throws(() => parse('hello'), NumError);
  });

  it('throws for non-string input', () => {
    assert.throws(() => parse(42 as unknown as string), NumError);
  });

  it('message never echoes the input', () => {
    try {
      parse('secret_123');
    } catch (e) {
      assert.ok(e instanceof NumError);
      assert.ok(!e.message.includes('secret_123'));
    }
  });
});

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

describe('Num.money', () => {
  it('creates a dinero object from a number', () => {
    const m = money(12.99, 'USD');
    const snap = toSnapshot(m);
    assert.equal(snap.amount, 1299);
    assert.equal(snap.currency.code, 'USD');
  });

  it('creates a dinero object from a string', () => {
    const m = money('12.99', 'USD');
    const snap = toSnapshot(m);
    assert.equal(snap.amount, 1299);
    assert.equal(snap.currency.code, 'USD');
  });

  it('handles zero', () => {
    const m = money(0, 'USD');
    const snap = toSnapshot(m);
    assert.equal(snap.amount, 0);
  });

  it('handles JPY (zero decimal places)', () => {
    const m = money(500, 'JPY');
    const snap = toSnapshot(m);
    assert.equal(snap.amount, 500);
    assert.equal(snap.currency.code, 'JPY');
  });

  it('throws for unknown currency', () => {
    assert.throws(() => money(10, 'XXX'), NumError);
  });

  it('throws for NaN amount', () => {
    assert.throws(() => money(NaN, 'USD'), NumError);
  });
});

// ---------------------------------------------------------------------------
// money arithmetic (add / subtract / compare)
// ---------------------------------------------------------------------------

describe('money arithmetic', () => {
  it('add returns a new dinero with correct amount', () => {
    const a = money(10.0, 'USD');
    const b = money(2.5, 'USD');
    const result = add(a, b);
    assert.equal(toSnapshot(result).amount, 1250);
  });

  it('subtract returns a new dinero with correct amount', () => {
    const a = money(10.0, 'USD');
    const b = money(2.5, 'USD');
    const result = subtract(a, b);
    assert.equal(toSnapshot(result).amount, 750);
  });

  it('compare returns -1 when first is less', () => {
    const a = money(5, 'USD');
    const b = money(10, 'USD');
    assert.equal(compare(a, b), -1);
  });

  it('compare returns 0 when equal', () => {
    const a = money(10, 'USD');
    const b = money(10, 'USD');
    assert.equal(compare(a, b), 0);
  });

  it('compare returns 1 when first is greater', () => {
    const a = money(15, 'USD');
    const b = money(10, 'USD');
    assert.equal(compare(a, b), 1);
  });

  it('handles negative amounts in arithmetic', () => {
    const a = money(-5, 'USD');
    const b = money(10, 'USD');
    const result = add(a, b);
    assert.equal(toSnapshot(result).amount, 500);
  });
});

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------

describe('Num.formatMoney', () => {
  it('formats a dinero object', () => {
    const m = money(12.99, 'USD');
    const result = formatMoney(m, {});
    assert.equal(result, '$12.99');
  });

  it('formats a number with explicit currency', () => {
    const result = formatMoney(12.99, { currency: 'USD' });
    assert.equal(result, '$12.99');
  });

  it('formats with locale', () => {
    const m = money(1234.56, 'EUR');
    const result = formatMoney(m, { locale: 'de-DE' });
    assert.ok(result.includes('1.234,56'));
  });

  it('formats with accounting style (negative in parens)', () => {
    const m = money(-12.99, 'USD');
    const result = formatMoney(m, { accounting: true });
    assert.equal(result, '($12.99)');
  });

  it('accounting does not affect positive amounts', () => {
    const m = money(12.99, 'USD');
    const result = formatMoney(m, { accounting: true });
    assert.equal(result, '$12.99');
  });

  it('respects minorUnits override', () => {
    const m = money(12.99, 'USD');
    const result = formatMoney(m, { minorUnits: 0 });
    assert.equal(result, '$13');
  });

  it('formats JPY with zero decimal places', () => {
    const m = money(500, 'JPY');
    const result = formatMoney(m, {});
    assert.equal(result, '¥500');
  });

  it('throws for non-Money input without currency', () => {
    assert.throws(() => formatMoney(10, {}), NumError);
  });

  it('throws for invalid minorUnits', () => {
    assert.throws(() => formatMoney(10, { currency: 'USD', minorUnits: -1 }), NumError);
  });

  it('handles zero', () => {
    const m = money(0, 'USD');
    assert.equal(formatMoney(m, {}), '$0.00');
  });
});

// ---------------------------------------------------------------------------
// Num is frozen
// ---------------------------------------------------------------------------

describe('Num namespace', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(Num));
    assert.throws(() => {
      (Num as Record<string, unknown>).extra = true;
    }, TypeError);
  });

  it('contains all expected methods', () => {
    const keys = Object.keys(Num);
    assert.ok(keys.includes('format'));
    assert.ok(keys.includes('compact'));
    assert.ok(keys.includes('currency'));
    assert.ok(keys.includes('percent'));
    assert.ok(keys.includes('unit'));
    assert.ok(keys.includes('bytes'));
    assert.ok(keys.includes('ordinal'));
    assert.ok(keys.includes('clamp'));
    assert.ok(keys.includes('round'));
    assert.ok(keys.includes('parse'));
    assert.ok(keys.includes('money'));
    assert.ok(keys.includes('formatMoney'));
  });
});

// ---------------------------------------------------------------------------
// NumError value-free safety
// ---------------------------------------------------------------------------

describe('NumError value-free safety', () => {
  it('code is invalid_argument', () => {
    const err = new NumError('test');
    assert.equal(err.code, 'invalid_argument');
  });

  it('is an instance of NumError', () => {
    assert.throws(
      () => format(NaN),
      (e: unknown) => e instanceof NumError,
    );
  });
});
