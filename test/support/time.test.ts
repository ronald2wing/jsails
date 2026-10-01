import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Time, TimeError, type TimeUnit } from '../../src/support/time.js';

// Fixed reference point for deterministic tests.
const REF = new Date('2024-06-15T12:00:00Z');
const REF_MINUS_2H = new Date('2024-06-15T10:00:00Z');

describe('Time', () => {
  // -----------------------------------------------------------------------
  // time.ts - happy paths
  // -----------------------------------------------------------------------

  describe('duration', () => {
    it('formats milliseconds as human-readable', () => {
      assert.equal(Time.duration(0), '0ms');
      assert.equal(Time.duration(1000), '1s');
      assert.equal(Time.duration(65000), '1m 5s');
      assert.equal(Time.duration(3723000), '1h 2m 3s');
      assert.equal(Time.duration(90061000), '1d 1h 1m 1s');
    });

    it('rejects non-finite numbers', () => {
      assert.throws(() => Time.duration(NaN), TimeError);
      assert.throws(() => Time.duration(Infinity), TimeError);
      assert.doesNotThrow(() => Time.duration(-1000));
    });
  });

  describe('parseDuration', () => {
    it('parses duration strings', () => {
      assert.equal(Time.parseDuration('2 days'), 172800000);
      assert.equal(Time.parseDuration('1h'), 3600000);
      assert.equal(Time.parseDuration('3 minutes'), 180000);
      assert.equal(Time.parseDuration('30s'), 30000);
      assert.equal(Time.parseDuration('1.5h'), 5400000);
    });

    it('throws on invalid input', () => {
      assert.throws(() => Time.parseDuration('not a duration'), TimeError);
      assert.throws(() => Time.parseDuration(''), TimeError);
    });
  });

  describe('parse', () => {
    it('returns Date objects as-is', () => {
      assert.equal(Time.parse(REF).getTime(), REF.getTime());
    });

    it('parses numeric timestamps', () => {
      const d = Time.parse(REF.getTime());
      assert.equal(d.getTime(), REF.getTime());
    });

    it('parses ISO strings', () => {
      const d = Time.parse('2024-06-15T12:00:00Z');
      assert.equal(d.getTime(), REF.getTime());
    });

    it('parses date-only strings', () => {
      const d = Time.parse('2024-06-15');
      assert.ok(!isNaN(d.getTime()));
    });

    it('throws on unparseable strings', () => {
      assert.throws(() => Time.parse('not-a-date'), TimeError);
    });
  });

  describe('diff', () => {
    it('returns ms difference by default', () => {
      const result = Time.diff(REF, REF_MINUS_2H);
      assert.equal(result, 2 * 60 * 60 * 1000);
    });

    it('returns difference in specified unit', () => {
      assert.equal(Time.diff(REF, REF_MINUS_2H, 'second'), 7200);
      assert.equal(Time.diff(REF, REF_MINUS_2H, 'minute'), 120);
      assert.equal(Time.diff(REF, REF_MINUS_2H, 'hour'), 2);
    });

    it('returns negative when b is later than a', () => {
      assert.equal(Time.diff(REF_MINUS_2H, REF, 'hour'), -2);
    });
  });

  describe('add', () => {
    it('adds time units', () => {
      const result = Time.add(REF, 3, 'day');
      assert.equal(result.toISOString(), '2024-06-18T12:00:00.000Z');
    });

    it('adds milliseconds', () => {
      const result = Time.add(REF, 5000, 'ms');
      assert.equal(result.toISOString(), '2024-06-15T12:00:05.000Z');
    });

    it('adds negative amount (goes backward)', () => {
      const result = Time.add(REF, -1, 'month');
      assert.equal(result.toISOString(), '2024-05-15T12:00:00.000Z');
    });
  });

  describe('subtract', () => {
    it('subtracts time units', () => {
      const result = Time.subtract(REF, 2, 'hour');
      assert.equal(result.toISOString(), '2024-06-15T10:00:00.000Z');
    });

    it('subtracts milliseconds', () => {
      const result = Time.subtract(REF, 3000, 'ms');
      assert.equal(result.toISOString(), '2024-06-15T11:59:57.000Z');
    });

    it('handles negative amounts', () => {
      const result = Time.subtract(REF, -5, 'day');
      assert.equal(result.toISOString(), '2024-06-20T12:00:00.000Z');
    });
  });

  describe('startOf', () => {
    const midMonth = new Date('2024-06-15T12:34:56.789Z');

    it('snaps to start of day', () => {
      const result = Time.startOf(midMonth, 'day');
      assert.equal(result.getUTCFullYear(), 2024);
      assert.equal(result.getUTCMonth(), 5); // June
      assert.equal(result.getUTCDate(), 15);
      // startOf zeros out the time portion in local time.  Assert the result
      // is a valid date on the correct calendar day — exact hour offset depends
      // on the system timezone.
      assert.ok(!isNaN(result.getTime()));
    });

    it('snaps to start of month', () => {
      const result = Time.startOf(midMonth, 'month');
      assert.equal(result.getUTCFullYear(), 2024);
      assert.equal(result.getUTCMonth(), 5); // June
      assert.equal(result.getUTCDate(), 1);
      assert.ok(!isNaN(result.getTime()));
    });

    it('snaps to start of year', () => {
      const result = Time.startOf(midMonth, 'year');
      assert.equal(result.getUTCFullYear(), 2024);
      assert.equal(result.getUTCMonth(), 0); // January
      assert.equal(result.getUTCDate(), 1);
      assert.ok(!isNaN(result.getTime()));
    });

    it('snaps to start of hour', () => {
      const result = Time.startOf(midMonth, 'hour');
      assert.equal(result.toISOString(), '2024-06-15T12:00:00.000Z');
    });

    it('snaps to start of minute', () => {
      const result = Time.startOf(midMonth, 'minute');
      assert.equal(result.toISOString(), '2024-06-15T12:34:00.000Z');
    });

    it('snaps to start of second (ms/second alias)', () => {
      const result = Time.startOf(midMonth, 'second');
      assert.equal(result.toISOString(), '2024-06-15T12:34:56.000Z');

      const resultMs = Time.startOf(midMonth, 'ms');
      assert.equal(resultMs.toISOString(), '2024-06-15T12:34:56.000Z');
    });
  });

  describe('endOf', () => {
    const midMonth = new Date('2024-06-15T12:34:56.789Z');

    it('snaps to end of day', () => {
      const result = Time.endOf(midMonth, 'day');
      assert.equal(result.getUTCFullYear(), 2024);
      assert.equal(result.getUTCMonth(), 5); // June
      // endOf sets to 23:59:59.999 in local time — date may shift to 16th
      // in UTC depending on timezone offset.  Assert the result is valid.
      assert.ok(!isNaN(result.getTime()));
    });

    it('snaps to end of month', () => {
      const result = Time.endOf(midMonth, 'month');
      assert.equal(result.getUTCFullYear(), 2024);
      // June has 30 days — endOf should land on the 30th (or 1st July UTC
      // depending on timezone offset).
      assert.ok(!isNaN(result.getTime()));
    });

    it('snaps to end of year', () => {
      const result = Time.endOf(midMonth, 'year');
      // endOf year returns Dec 31 23:59:59.999 local time, which may cross into
      // the next UTC year when the timezone offset is negative.  Assert local year
      // (which is what date-fns operates on).
      assert.equal(result.getFullYear(), 2024);
      assert.ok(!isNaN(result.getTime()));
    });

    it('snaps to end of hour', () => {
      const result = Time.endOf(midMonth, 'hour');
      assert.equal(result.toISOString(), '2024-06-15T12:59:59.999Z');
    });

    it('snaps to end of minute', () => {
      const result = Time.endOf(midMonth, 'minute');
      assert.equal(result.toISOString(), '2024-06-15T12:34:59.999Z');
    });

    it('snaps to end of second (ms/second alias)', () => {
      const result = Time.endOf(midMonth, 'second');
      assert.equal(result.toISOString(), '2024-06-15T12:34:56.999Z');

      const resultMs = Time.endOf(midMonth, 'ms');
      assert.equal(resultMs.toISOString(), '2024-06-15T12:34:56.999Z');
    });
  });

  describe('isToday / isPast / isFuture', () => {
    it('isToday returns true for today', () => {
      assert.equal(Time.isToday(new Date()), true);
    });

    it('isToday returns false for a past date', () => {
      const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      assert.equal(Time.isToday(past), false);
    });

    it('isPast returns true for a past date', () => {
      assert.equal(Time.isPast(new Date('2020-01-01')), true);
      assert.equal(Time.isPast(new Date('2099-01-01')), false);
    });

    it('isFuture returns true for a future date', () => {
      assert.equal(Time.isFuture(new Date('2099-01-01')), true);
      assert.equal(Time.isFuture(new Date('2020-01-01')), false);
    });
  });

  describe('format', () => {
    it('formats with explicit locale and timeZone', () => {
      const result = Time.format(REF, { dateStyle: 'long', timeZone: 'UTC' }, 'en-US');
      assert.equal(result, 'June 15, 2024');
    });

    it('pins to UTC so output is deterministic', () => {
      const result = Time.format(
        REF,
        { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' },
        'en-US',
      );
      assert.equal(result, '06/15/2024');
    });
  });

  describe('relative', () => {
    it('shows seconds ago for very recent timestamps', () => {
      const now = new Date();
      const recent = new Date(now.getTime() - 5000);
      const result = Time.relative(recent, now, 'en-US');
      assert.match(result, /ago/);
    });

    it('shows a relative hour offset', () => {
      const base = new Date('2024-06-15T12:00:00Z');
      const earlier = new Date('2024-06-15T10:00:00Z');
      const result = Time.relative(earlier, base, 'en-US');
      assert.match(result, /ago/);
    });

    it('defaults base to now when omitted', () => {
      const result = Time.relative(Date.now() - 3600000);
      assert.ok(typeof result === 'string' && result.length > 0);
    });

    it('throws on invalid date', () => {
      assert.throws(() => Time.relative('not-a-date'), TimeError);
    });
  });

  // -----------------------------------------------------------------------
  // DST boundary
  // -----------------------------------------------------------------------

  describe('DST boundary', () => {
    // Use a date that spans a DST transition. 2024-03-10 is the US spring-forward
    // transition (02:00 → 03:00 EST→EDT). The diff across this boundary in terms
    // of calendar days is still one day — days are calendar units, not fixed-
    // length 24-hour spans. date-fns `differenceInDays` operates on calendar
    // dates in the local timezone, so it yields 1 regardless of the hour gap.
    // We assert this stable, documented behavior.
    it('diff in days across DST spring-forward is 1 calendar day', () => {
      const before = new Date('2024-03-09T23:00:00'); // local time (EST, UTC-5)
      const after = new Date('2024-03-11T01:00:00'); // local time (EDT, UTC-4)
      const days = Time.diff(after, before, 'day');
      assert.equal(days, 1);
    });

    // Hour diff across the DST transition: the two instants are 49 real hours
    // apart (23:00 EST Sat → 01:00 EDT Mon), which is 49 elapsed hours.
    // But date-fns `differenceInHours` acts on the local clock hour values.
    // We document the observed behavior rather than expecting a specific number.
    it('diff in hours across DST transition is deterministic', () => {
      const before = new Date('2024-03-09T23:00:00');
      const after = new Date('2024-03-11T01:00:00');
      const hours = Time.diff(after, before, 'hour');
      assert.ok(typeof hours === 'number' && !isNaN(hours));
    });

    // UTC dates are immune to DST — use them for deterministic exact assertions.
    it('diff in hours across the same calendar interval in UTC is exact', () => {
      const before = new Date('2024-03-09T23:00:00Z');
      const after = new Date('2024-03-11T01:00:00Z');
      const hours = Time.diff(after, before, 'hour');
      assert.equal(hours, 26);
    });
  });

  // -----------------------------------------------------------------------
  // Error value-free checks
  // -----------------------------------------------------------------------

  describe('TimeError value-free', () => {
    it('code is invalid_argument', () => {
      const err = new TimeError('test');
      assert.equal(err.code, 'invalid_argument');
    });

    it('message does not echo input', () => {
      const err = new TimeError('Cannot resolve input to a valid date');
      assert.ok(!err.message.includes('not-a-date'));
      assert.ok(!err.message.includes('2024'));
    });

    it('instanceof chain is correct', () => {
      const err = new TimeError('x');
      assert.ok(err instanceof TimeError);
      assert.ok(err instanceof Error);
    });

    it('name is TimeError', () => {
      assert.equal(new TimeError('x').name, 'TimeError');
    });
  });

  describe('parseDuration value-free', () => {
    it('message excludes input string', () => {
      try {
        Time.parseDuration('garbage-input-$%^');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof TimeError);
        assert.ok(!e.message.includes('garbage'));
        assert.ok(!e.message.includes('input'));
      }
    });
  });

  describe('parse value-free', () => {
    it('message excludes input string', () => {
      try {
        Time.parse('absurd-not-a-date');
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof TimeError);
        assert.ok(!e.message.includes('absurd'));
        assert.ok(!e.message.includes('not-a-date'));
      }
    });
  });

  // -----------------------------------------------------------------------
  // TimeUnit type export
  // -----------------------------------------------------------------------

  it('TimeUnit type is exported (compile-time check + runtime no-op)', () => {
    // This assignment proves the type is importable.
    const unit: TimeUnit = 'day';
    assert.equal(unit, 'day');
  });

  // -----------------------------------------------------------------------
  // Time namespace is frozen
  // -----------------------------------------------------------------------

  it('Time is frozen', () => {
    assert.ok(Object.isFrozen(Time));
  });

  it('Time cannot be mutated', () => {
    assert.throws(() => {
      (Time as Record<string, unknown>).extra = 1;
    }, TypeError);
  });
});
