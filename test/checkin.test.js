const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../out/checkin.js');

test('todayString 用 sv locale 产出 YYYY-MM-DD', () => {
  assert.strictEqual(c.todayString(new Date(2026, 9, 4, 13, 5)), '2026-10-04');
  assert.strictEqual(c.todayString(new Date(2026, 0, 1, 0, 0)), '2026-01-01');
});

test('shouldCheckin 只看今天成功过没有', () => {
  assert.strictEqual(c.shouldCheckin(undefined, '2026-10-04'), true);
  assert.strictEqual(c.shouldCheckin('2026-10-03', '2026-10-04'), true);
  assert.strictEqual(c.shouldCheckin('2026-10-04', '2026-10-04'), false);
});

test('nextCheckinRetryAt 排在当天 23:50', () => {
  const at = c.nextCheckinRetryAt(new Date(2026, 9, 4, 9, 0));
  assert.strictEqual(at.getFullYear(), 2026);
  assert.strictEqual(at.getMonth(), 9);
  assert.strictEqual(at.getDate(), 4);
  assert.strictEqual(at.getHours(), 23);
  assert.strictEqual(at.getMinutes(), 50);
});

test('nextCheckinRetryAt 已过 23:50 则顺延到明天同一刻', () => {
  const at = c.nextCheckinRetryAt(new Date(2026, 9, 4, 23, 50));
  assert.strictEqual(at.getDate(), 5);
  assert.strictEqual(at.getHours(), 23);
  assert.strictEqual(at.getMinutes(), 50);
});

test('nextCheckinRetryAt 月末顺延不越界', () => {
  const at = c.nextCheckinRetryAt(new Date(2026, 9, 31, 23, 55));
  assert.strictEqual(at.getMonth(), 10);
  assert.strictEqual(at.getDate(), 1);
});

test('accountKeyOf 同 token 稳定、换 token 必不同、无名返回 unknown', () => {
  assert.strictEqual(c.accountKeyOf('a.b.c'), c.accountKeyOf('a.b.c'));
  assert.notStrictEqual(c.accountKeyOf('a.b.c'), c.accountKeyOf('x.y.z'));
  assert.strictEqual(c.accountKeyOf(undefined), 'unknown');
  assert.strictEqual(c.accountKeyOf(''), 'unknown');
});
