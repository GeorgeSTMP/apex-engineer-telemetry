import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionTransitionMessage,
  formatSessionTypeLabel,
  getEffectiveSessionType,
  parseAccSessionType,
  parseGenericSessionType,
  parseLmuNumericSession,
  parseLmuSessionType,
} from './sessionPhase';

test('parseLmuSessionType detects Practice, Qualifying, and Race from REST session strings and codes', () => {
  assert.deepEqual(parseLmuSessionType({ session: 'PRACTICE1' }), {
    sessionType: 'practice',
    rawSessionName: 'PRACTICE1',
  });
  assert.deepEqual(parseLmuSessionType({ session: 'QUALIFY' }), {
    sessionType: 'qualifying',
    rawSessionName: 'QUALIFY',
  });
  assert.deepEqual(parseLmuSessionType({ session: 'HYPERPOLE' }), {
    sessionType: 'qualifying',
    rawSessionName: 'HYPERPOLE',
  });
  assert.deepEqual(parseLmuSessionType({ session: 'RACE1' }), {
    sessionType: 'race',
    rawSessionName: 'RACE1',
  });
  assert.deepEqual(parseLmuSessionType({ session: 6 }), {
    sessionType: 'qualifying',
    rawSessionName: '6',
  });
  assert.deepEqual(parseLmuSessionType({ session: 10 }), {
    sessionType: 'race',
    rawSessionName: '10',
  });
  assert.equal(parseLmuSessionType({ gamePhase: 'FORMATION' }).sessionType, 'race');
});

test('parseAccSessionType maps ACC AC_SESSION_TYPE enum accurately', () => {
  assert.equal(parseAccSessionType(0), 'practice');
  assert.equal(parseAccSessionType(1), 'qualifying');
  assert.equal(parseAccSessionType(2), 'race');
  assert.equal(parseAccSessionType(3), 'practice'); // Hotlap
  assert.equal(parseAccSessionType(7), 'practice'); // Hotstint
  assert.equal(parseAccSessionType(8), 'qualifying'); // Superpole
  assert.equal(parseAccSessionType(-1), 'unknown');
});

test('parseGenericSessionType & parseLmuNumericSession handle abbreviations cleanly', () => {
  assert.equal(parseGenericSessionType('FP2'), 'practice');
  assert.equal(parseGenericSessionType('Q2'), 'qualifying');
  assert.equal(parseGenericSessionType('Warmup'), 'warmup');
  assert.equal(parseGenericSessionType('Sprint Race'), 'race');
  assert.equal(parseLmuNumericSession(0), 'practice');
  assert.equal(parseLmuNumericSession(9), 'warmup');
  assert.equal(formatSessionTypeLabel('qualifying'), 'Qualifying');
  assert.equal(formatSessionTypeLabel('unknown'), null);
});

test('getEffectiveSessionType prioritizes manual override or falls back to live frame/status', () => {
  assert.equal(
    getEffectiveSessionType({
      override: 'auto',
      frameSessionType: 'qualifying',
      simStatus: { gameRunning: true, sessionType: 'practice' },
    }),
    'qualifying'
  );
  assert.equal(
    getEffectiveSessionType({
      override: 'race',
      frameSessionType: 'practice',
      simStatus: { gameRunning: true, sessionType: 'practice' },
    }),
    'race'
  );
});

test('buildSessionTransitionMessage produces Pit Radio guidance for Practice -> Qualifying -> Race', () => {
  const p = buildSessionTransitionMessage('practice', 'unknown');
  const q = buildSessionTransitionMessage('qualifying', 'practice');
  const r = buildSessionTransitionMessage('race', 'qualifying');
  assert.ok(p?.message.includes('Practice session'));
  assert.ok(q?.message.includes('Qualifying session'));
  assert.ok(r?.message.includes('Race session'));
  assert.equal(buildSessionTransitionMessage('race', 'race'), null);
});
