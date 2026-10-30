const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../out/format.js');
test('fmtCredits 万/亿压缩', () => {
  assert.strictEqual(f.fmtCredits(9999), '9,999');
  assert.strictEqual(f.fmtCredits(10000), '1w');
  assert.strictEqual(f.fmtCredits(15000), '1.5w');
  assert.strictEqual(f.fmtCredits(200000000), '2亿');
  assert.strictEqual(f.fmtCredits(NaN), '-');
});
test('fmtCredits 保留 4 位有效数字，w 档进位到亿', () => {
  assert.strictEqual(f.fmtCredits(17640), '1.764w');
  assert.strictEqual(f.fmtCredits(16440), '1.644w');
  assert.strictEqual(f.fmtCredits(123456), '12.35w');
  assert.strictEqual(f.fmtCredits(1234567), '123.5w');
  assert.strictEqual(f.fmtCredits(9999000), '999.9w');
  // 99,999,999 在 w 档四舍五入会变成 10,000w（41px 宽串），必须升级成亿
  assert.strictEqual(f.fmtCredits(99999999), '1亿');
  assert.strictEqual(f.fmtCredits(999999), '100w');
});
test('pctOf 四舍五入、封顶与下限', () => {
  assert.strictEqual(f.pctOf(1760, 3000), 59);
  assert.strictEqual(f.pctOf(94.5, 100), 95);
  assert.strictEqual(f.pctOf(94.4, 100), 94);
  assert.strictEqual(f.pctOf(999, 1000), 99);
  assert.strictEqual(f.pctOf(1000, 1000), 100);
  assert.strictEqual(f.pctOf(0, 3000), 0);
  assert.strictEqual(f.pctOf(4000, 3000), 100);
  assert.strictEqual(f.pctOf(100, 0), 0);
});
test('formatDateTime 到分钟，无到期显示 -', () => {
  assert.strictEqual(f.formatDateTime('2026-12-31 18:38:23'), '2026-12-31 18:38');
  assert.strictEqual(f.formatDateTime('2027-01-15T08:00:00'), '2027-01-15 08:00');
  assert.strictEqual(f.formatDateTime(undefined), '-');
  assert.strictEqual(f.formatDateTime(''), '-');
});
