const { test } = require('node:test');
const assert = require('node:assert');
const api = require('../out/api.js');
const fixture = { data: { Response: { Data: { Accounts: [
  { PackageName: '基础积分包', CycleCapacityRemainPrecise: '760', CycleCapacitySizePrecise: '2000', CycleEndTime: '2026-12-31 18:38:23' },
  { PackageName: '活动赠送包', CycleCapacityRemainPrecise: '1000', CycleCapacitySizePrecise: '1000', CycleEndTime: '2027-01-15 00:00:00' },
  { PackageName: '已用完包', CycleCapacityRemainPrecise: '0', CycleCapacitySizePrecise: '500', CycleEndTime: '2026-10-05 00:00:00' }
] } } } };
test('shapeUsage 汇总并过滤已用完的包', () => {
  const s = api.shapeUsage(fixture);
  assert.strictEqual(s.remain, 1760);
  assert.strictEqual(s.total, 3000);
  assert.strictEqual(s.packs.length, 2);
  assert.strictEqual(s.packs[0].name, '基础积分包');
});
test('shapeUsage 一个包都没有时明确报错，而不是显示 0/0', () => {
  assert.throws(() => api.shapeUsage({}), /没有任何积分包/);
  assert.throws(() => api.shapeUsage({ data: { Response: { Data: { Accounts: [] } } } }), /没有任何积分包/);
});
test('shapeUsage 套餐名不是字符串时回落，不把 TypeError 摆到界面上', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: 12345, CycleCapacityRemainPrecise: '5', CycleCapacitySizePrecise: '10', CycleEndTime: '' }
  ] } } } });
  assert.strictEqual(s.packs[0].name, '-');
});
test('HTTP 200 但业务 code 非 0 要抛错，正文只进 remoteDetail', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 1001, message: 'token invalid https://evil.example.com/x' }) });
  try {
    await assert.rejects(() => api.fetchUsage({ mode: 'auto', token: 't' }), (e) => {
      assert.match(e.message, /业务错误码 1001/);
      assert.ok(!/https?:/.test(e.message), e.message);
      assert.ok(!/https?:/.test(e.remoteDetail || ''), e.remoteDetail);
      return true;
    });
  } finally {
    globalThis.fetch = orig;
  }
});
test('shapeUsage 无周期字段回落总容量字段', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [{ PackageName: 'x', CapacityRemainPrecise: '5', CapacitySizePrecise: '10', CycleEndTime: '' }] } } } });
  assert.strictEqual(s.remain, 5);
  assert.strictEqual(s.total, 10);
  assert.strictEqual(s.unlimited, false);
});
test('shapeUsage 全是 -1 时整体不限量，limit 记 0', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [{ PackageName: '不限量包', CycleCapacityRemainPrecise: '-1', CycleCapacitySizePrecise: '-1', CycleEndTime: '' }] } } } });
  assert.strictEqual(s.unlimited, true);
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.packs.length, 1);
  assert.strictEqual(s.packs[0].unlimited, true);
});
test('shapeUsage 不限量与有限额混合时，整体不得判成不限量', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: '定额', CycleCapacityRemainPrecise: '760', CycleCapacitySizePrecise: '2000', CycleEndTime: '' },
    { PackageName: '不限量', CycleCapacityRemainPrecise: '-1', CycleCapacitySizePrecise: '-1', CycleEndTime: '' }
  ] } } } });
  assert.strictEqual(s.unlimited, false);
  assert.strictEqual(s.remain, 760);
  assert.strictEqual(s.total, 2000);
  assert.strictEqual(s.packs.length, 2);
});
test('shapeCheckinStatus', () => {
  assert.strictEqual(api.shapeCheckinStatus({ data: { today_checked_in: true } }), 'claimed');
  assert.strictEqual(api.shapeCheckinStatus({ data: { today_checked_in: false } }), 'unclaimed');
});
test('shapeBuddyStatus', () => {
  const b = api.shapeBuddyStatus({ code: 0, data: { state: 'traveling', depart_at: 1, arrive_at: 2, daily_limit_reached: false } });
  assert.strictEqual(b.state, 'traveling');
  assert.strictEqual(b.departAt, 1);
  assert.strictEqual(api.shapeBuddyStatus({ code: 1 }), null);
});
test('safeSnippet 抹掉 URL 与 Markdown 语法', () => {
  const out = api.safeSnippet('请访问 https://evil.example.com/a 或 [点我](https://x.y) ![图](http://z)');
  assert.ok(!/https?:\/\//.test(out), out);
  assert.ok(!/[[\]()]/.test(out), out);
});
test('safeSnippet 去掉零宽/双向控制符并按上限截断', () => {
  const out = api.safeSnippet(`a\u200Bb\u202Ec${'x'.repeat(200)}`, 20);
  assert.ok(!/[\u200B-\u200F\u202A-\u202E]/.test(out));
  assert.strictEqual(out.length, 20);
});
test('apiError 把远程正文放进 remoteDetail 而不是 message', () => {
  const e = api.apiError('请求积分接口返回 HTTP 502', { remoteBody: 'boom https://a.b [x](y)', httpStatus: 502 });
  assert.strictEqual(e.message, '请求积分接口返回 HTTP 502');
  assert.strictEqual(e.httpStatus, 502);
  assert.ok(!/https?:/.test(e.remoteDetail), e.remoteDetail);
});
