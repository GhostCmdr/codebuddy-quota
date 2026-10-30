const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../out/auth.js');

const now = () => Date.now();
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const fresh = (off = 3600) => jwt({ exp: Math.floor(now() / 1000) + off });
const cnToken = () => jwt({ exp: Math.floor(now() / 1000) + 3600, iss: 'https://www.codebuddy.cn' });
const intlToken = () => jwt({ exp: Math.floor(now() / 1000) + 3600, iss: 'https://www.codebuddy.ai' });
const noStore = () => ({ get: async () => undefined, set: async () => {} });
const memStore = (init) => {
  const box = { v: init };
  return { get: async () => box.v, set: async (v) => { box.v = v; }, box };
};

test('当前编辑器的登录态优先于手动 Token', async () => {
  const auto = fresh();
  const manual = fresh();
  auth.configure({ manualToken: manual, store: noStore(), autoReader: async () => ({ token: auto }) });
  auth.invalidateAuth(true);
  const r = await auth.getAuth(true);
  assert.strictEqual(r.mode, 'auto');
  assert.strictEqual(r.token, auto);
});

test('宿主读不到 → 用上次读到的登录态兜底（仍是 auto）', async () => {
  const last = fresh();
  const store = memStore({ token: last, expiresAt: now() + 3 * 86400_000, mode: 'auto' });
  auth.configure({ manualToken: fresh(), store, autoReader: async () => ({ note: 'db locked' }) });
  auth.invalidateAuth(true);
  store.box.v = { token: last, expiresAt: now() + 3 * 86400_000, mode: 'auto' };
  const r = await auth.getAuth(true);
  assert.strictEqual(r.mode, 'auto');
  assert.strictEqual(r.token, last);
  assert.match(r.note, /读取失败/);
});

test('宿主读不到且没有缓存 → 用手动 Token 兜底', async () => {
  const manual = fresh();
  auth.configure({ manualToken: manual, store: noStore(), autoReader: async () => ({ note: 'no session' }) });
  auth.invalidateAuth(true);
  const r = await auth.getAuth(true);
  assert.strictEqual(r.mode, 'manual');
  assert.strictEqual(r.token, manual);
});

test('手动兜底后宿主恢复：下一次强制刷新自动切回 auto', async () => {
  const manual = fresh();
  let auto;
  auth.configure({
    manualToken: manual,
    store: noStore(),
    autoReader: async () => (auto ? { token: auto } : { note: 'no session' })
  });
  auth.invalidateAuth(true);
  const first = await auth.getAuth(true);
  assert.strictEqual(first.mode, 'manual');

  auto = fresh();
  const second = await auth.getAuth(true);
  assert.strictEqual(second.mode, 'auto');
  assert.strictEqual(second.token, auto);
});

test('读失败后冷却期内不重复解密，强制刷新可绕过冷却', async () => {
  let calls = 0;
  auth.configure({ manualToken: '', store: noStore(), autoReader: async () => { calls++; return { note: 'no session' }; } });
  auth.invalidateAuth(true);
  await auth.getAuth(true);
  assert.strictEqual(calls, 1);
  await auth.getAuth(); // 内存缓存命中
  assert.strictEqual(calls, 1);
  await auth.getAuth(true); // 强制 → 再读一次
  assert.strictEqual(calls, 2);
});

test('什么都没有 → none，并带上失败原因', async () => {
  auth.configure({ manualToken: '', store: noStore(), autoReader: async () => ({ note: 'no session' }) });
  auth.invalidateAuth(true);
  const r = await auth.getAuth(true);
  assert.strictEqual(r.mode, 'none');
  assert.strictEqual(r.note, 'no session');
});

test('iss 为 codebuddy.ai 时只探国际站，且 base 按区域分桶', async () => {
  const intl = intlToken();
  const cn = cnToken();
  const probed = [];
  const b1 = await auth.resolveBillingBase({ mode: 'auto', token: intl }, async (b) => { probed.push(b); return b === 'https://www.codebuddy.ai/v2'; });
  assert.strictEqual(b1, 'https://www.codebuddy.ai/v2');
  assert.deepStrictEqual(probed, ['https://www.codebuddy.ai/v2'], '国际站不该去探国内域名');

  const b2 = await auth.resolveBillingBase({ mode: 'auto', token: cn }, async (b) => b === 'https://www.codebuddy.cn/v2');
  assert.strictEqual(b2, 'https://www.codebuddy.cn/v2');
  // 两个区域各记各的，换号不会串用
  assert.strictEqual(auth.getBillingBase({ mode: 'auto', token: cn }), 'https://www.codebuddy.cn/v2');
  assert.strictEqual(auth.getBillingBase({ mode: 'auto', token: intl }), 'https://www.codebuddy.ai/v2');
  assert.strictEqual(auth.preferredBillingBase({ mode: 'auto', token: intl }), 'https://www.codebuddy.ai/v2');
});

test('区域设置：强制国内/国际覆盖 iss，非法值回落自动', async () => {
  const intl = intlToken();
  const cn = cnToken();
  auth.setRegionPolicy('cn');
  assert.strictEqual(auth.isInternationalAuth({ mode: 'auto', token: intl }), false, '强制国内时国际 token 也走国内');

  auth.setRegionPolicy('intl');
  assert.strictEqual(auth.isInternationalAuth({ mode: 'auto', token: cn }), true, '强制国际时国内 token 也走国际');
  const probed = [];
  await auth.resolveBillingBase({ mode: 'auto', token: cn }, async (b) => { probed.push(b); return false; });
  assert.deepStrictEqual(probed, ['https://www.codebuddy.ai/v2'], '强制国际后候选只剩国际站');

  auth.setRegionPolicy('bogus');
  assert.strictEqual(auth.isInternationalAuth({ mode: 'auto', token: intl }), true, '非法值回落 auto');
  assert.strictEqual(auth.isInternationalAuth({ mode: 'auto', token: cn }), false);
  auth.setRegionPolicy('auto');
});

test('非 JWT / 无 iss 一律按国内处理', async () => {
  assert.strictEqual(auth.isInternationalAuth({ mode: 'auto', token: 'plain-token' }), false);
  assert.strictEqual(auth.isInternationalAuth({ mode: 'none' }), false);
  assert.strictEqual(auth.isInternationalAuth({ mode: 'auto', token: intlToken() }), true);
});

test('authHeaders', () => {
  assert.deepStrictEqual(auth.authHeaders({ mode: 'auto', token: 'abc' }), { authorization: 'Bearer abc' });
  assert.deepStrictEqual(auth.authHeaders({ mode: 'none' }), {});
});

test('凭证只允许发往官方白名单（含国际站），子域/明文/第三方一律拒', () => {
  assert.ok(auth.isAllowedCredentialTarget('https://www.workbuddy.cn/billing/meter'));
  assert.ok(auth.isAllowedCredentialTarget('https://www.codebuddy.cn/v2/billing/meter'));
  assert.ok(auth.isAllowedCredentialTarget('https://www.codebuddy.ai/v2/billing/meter'));
  assert.ok(!auth.isAllowedCredentialTarget('https://evil.example.com/'));
  assert.ok(!auth.isAllowedCredentialTarget('https://www.workbuddy.cn.evil.com/'));
  assert.ok(!auth.isAllowedCredentialTarget('https://www.codebuddy.ai.evil.com/'));
  assert.ok(!auth.isAllowedCredentialTarget('http://www.codebuddy.ai/'));
  assert.ok(!auth.isAllowedCredentialTarget('not a url'));
  assert.throws(() => auth.assertAllowedCredentialTarget('https://evil.example.com/'), /不在允许列表/);
});
