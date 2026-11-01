const { test } = require('node:test');
const assert = require('node:assert');
const api = require('../out/api.js');
const fixture = { data: { Response: { Data: { Accounts: [
  { PackageName: '基础积分包', CycleCapacityRemainPrecise: '760', CycleCapacitySizePrecise: '2000', CycleEndTime: '2026-12-31 18:38:23' },
  { PackageName: '活动赠送包', CycleCapacityRemainPrecise: '1000', CycleCapacitySizePrecise: '1000', CycleEndTime: '2027-01-15 00:00:00' },
  { PackageName: '已用完包', CycleCapacityRemainPrecise: '0', CycleCapacitySizePrecise: '500', CycleEndTime: '2026-10-05 00:00:00' }
] } } } };
test('shapeUsage 空包也返回、容量计入分母，展示层再决定显不显示', () => {
  const s = api.shapeUsage(fixture);
  assert.strictEqual(s.remain, 1760);
  assert.strictEqual(s.total, 3500);
  assert.strictEqual(s.packs.length, 3);
  assert.strictEqual(s.packs.find((p) => p.name === '已用完包').remain, 0);
});
test('shapeUsage 用 SubProductCode 区分套餐包与赠送包', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: '体验版', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '500', SubProductCode: 'sp_tcaca_codebuddy_ide' },
    { PackageName: '赠送包', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '100', SubProductCode: 'sp_tcaca_codebuddyide_bonus_pack' }
  ] } } } });
  assert.strictEqual(s.packs[0].plan, true);
  assert.strictEqual(s.packs[0].name, '基础积分');
  assert.strictEqual(s.packs[1].plan, false);

  const noSub = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: 'Free Plan Subscription', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '100' }
  ] } } } });
  assert.strictEqual(noSub.packs[0].plan, false, '没有 SubProductCode 时不能判成套餐包');
  assert.strictEqual(noSub.packs[0].name, 'Free Plan Subscription');
});

test('shapeUsage 按 grantSource / SubProductCode 显示网页端的友好名', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: 'CodeBuddy个人版国内运营裂变包', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '100', SubProductCode: 'sp_tcaca_codebuddyide_bonus_pack', AccountAttributes: [{ Key: 'grantSource', Value: 'daily_checkin' }] },
    { PackageName: 'CodeBuddy个人版国内运营裂变包', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '100', SubProductCode: 'sp_tcaca_codebuddyide_bonus_pack', AccountAttributes: [{ Key: 'grantSource', Value: 'growth_travel' }] },
    { PackageName: 'CodeBuddy个人体验版', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '500', SubProductCode: 'sp_tcaca_codebuddy_ide' },
    { PackageName: 'CodeBuddy个人版拉新权益包', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '100', SubProductCode: 'sp_tcaca_codebuddyide_bonus_pack', AccountAttributes: [{ Key: 'grantSource', Value: 'campaign_buddyone_join_2026' }] }
  ] } } } });
  assert.deepStrictEqual(s.packs.map((p) => p.name), [
    'Buddy 加油站签到',
    '成长计划奖励',
    '基础积分',
    '拉新权益包'
  ]);
  const variant = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: 'CodeBuddy个人测试免费包', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '100', SubProductCode: 'sp_tcaca_codebuddyide_bonus_pack' }
  ] } } } });
  assert.strictEqual(variant.packs[0].name, '测试免费包', '非「个人版」前缀也要削掉');
});

test('没有到期时间的包排在有到期时间的后面', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: '无到期', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '10', CycleEndTime: '' },
    { PackageName: '有到期', CycleCapacityRemainPrecise: '1', CycleCapacitySizePrecise: '10', CycleEndTime: '2026-11-01 00:00:00' }
  ] } } } });
  assert.deepStrictEqual(s.packs.map((p) => p.name), ['有到期', '无到期']);
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
test('业务 code 是字符串时同样按错误处理', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: '1001', message: 'boom' }) });
  try {
    await assert.rejects(() => api.fetchUsage({ mode: 'auto', token: 't' }), (e) => {
      assert.match(e.message, /业务错误码 1001/);
      return true;
    });
  } finally {
    globalThis.fetch = orig;
  }
});
test('业务 code 是字符串 "0" 时按成功处理', async () => {
  const orig = globalThis.fetch;
  const body = { code: '0', data: { Response: { Data: { Accounts: [{ PackageName: 'x', CycleCapacityRemainPrecise: '5', CycleCapacitySizePrecise: '10', CycleEndTime: '' }] } } } };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try {
    const s = await api.fetchUsage({ mode: 'auto', token: 't' });
    assert.strictEqual(s.remain, 5);
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
test('shapeUsage 不限量与有限额混合时，整体按不限量算', () => {
  const s = api.shapeUsage({ data: { Response: { Data: { Accounts: [
    { PackageName: '定额', CycleCapacityRemainPrecise: '760', CycleCapacitySizePrecise: '2000', CycleEndTime: '' },
    { PackageName: '不限量', CycleCapacityRemainPrecise: '-1', CycleCapacitySizePrecise: '-1', CycleEndTime: '' }
  ] } } } });
  assert.strictEqual(s.unlimited, true);
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
test('safeSnippet 截断点落在代理对中间时不留半个字符', () => {
  const out = api.safeSnippet('a😀b', 2);
  assert.strictEqual(out, 'a');
  assert.ok(!/[\uD800-\uDBFF]$/.test(out));
});
test('apiError 把远程正文放进 remoteDetail 而不是 message', () => {
  const e = api.apiError('请求积分接口返回 HTTP 502', { remoteBody: 'boom https://a.b [x](y)', httpStatus: 502 });
  assert.strictEqual(e.message, '请求积分接口返回 HTTP 502');
  assert.strictEqual(e.httpStatus, 502);
  assert.ok(!/https?:/.test(e.remoteDetail), e.remoteDetail);
});

const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const tokenOf = (iss) => jwt({ exp: Math.floor(Date.now() / 1000) + 3600, iss });

test('国际站：只打 codebuddy.ai，且不带国内包编码白名单', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return {
      ok: true, status: 200, json: async () => ({ data: { Response: { Data: { Accounts: [
        { PackageName: 'Free Plan Subscription', CycleCapacityRemainPrecise: '98.47', CycleCapacitySizePrecise: '100', CycleEndTime: '2026-10-31 23:59:59' }
      ] } } } })
    };
  };
  try {
    const s = await api.fetchUsage({ mode: 'auto', token: tokenOf('https://www.codebuddy.ai') });
    assert.strictEqual(s.remain, 98.47);
    assert.strictEqual(s.packs[0].name, 'Free Plan Subscription');
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.url.startsWith('https://www.codebuddy.ai/v2/')), calls.map((c) => c.url).join(','));
    assert.ok(calls.every((c) => !('PackageCodes' in (c.body || {}))), '国际站不该带 PackageCodes');
  } finally {
    globalThis.fetch = orig;
  }
});

test('国内站：沿用包编码白名单，不会打到国际域名', async () => {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ data: { Response: { Data: { Accounts: [
      { PackageName: '基础积分包', CycleCapacityRemainPrecise: '760', CycleCapacitySizePrecise: '2000', CycleEndTime: '2026-12-31 18:38:23' }
    ] } } } }) };
  };
  try {
    const s = await api.fetchUsage({ mode: 'auto', token: tokenOf('https://www.codebuddy.cn') });
    assert.strictEqual(s.remain, 760);
    assert.ok(calls.every((c) => !c.url.includes('codebuddy.ai')), calls.map((c) => c.url).join(','));
    assert.ok(calls.some((c) => Array.isArray(c.body && c.body.PackageCodes) && c.body.PackageCodes.length > 0));
  } finally {
    globalThis.fetch = orig;
  }
});
