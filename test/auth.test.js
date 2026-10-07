const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../out/auth.js');
const fresh = (off = 3600) => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + off })).toString('base64url')}.s`;

test('手动优先于宿主读取', async () => {
  const t = fresh();
  auth.configure({ manualToken: t, store: { get: async () => undefined, set: async () => {} } });
  auth.invalidateAuth(true);
  const r = await auth.getAuth();
  assert.strictEqual(r.mode, 'manual');
  assert.strictEqual(r.token, t);
});
test('无手动 Token 且当前宿主读不到 → none', async () => {
  auth.configure({ manualToken: '', store: { get: async () => undefined, set: async () => {} } });
  auth.invalidateAuth(true);
  const r = await auth.getAuth();
  assert.strictEqual(r.mode, 'none');
});
test('缓存命中直接用', async () => {
  const t = fresh();
  auth.configure({ manualToken: '', store: { get: async () => ({ token: t, expiresAt: Date.now() + 3 * 86400_000 }), set: async () => {} } });
  auth.invalidateAuth(true);
  const r = await auth.getAuth();
  assert.strictEqual(r.mode, 'auto');
  assert.strictEqual(r.token, t);
});
test('resolveBillingBase 选第一个探测成功的', async () => {
  const base = await auth.resolveBillingBase({ mode: 'auto', token: 't' }, async (b) => b === 'https://www.workbuddy.cn');
  assert.strictEqual(base, 'https://www.workbuddy.cn');
  assert.strictEqual(auth.getBillingBase(), 'https://www.workbuddy.cn');
});
test('authHeaders', () => {
  assert.deepStrictEqual(auth.authHeaders({ mode: 'auto', token: 'abc' }), { authorization: 'Bearer abc' });
  assert.deepStrictEqual(auth.authHeaders({ mode: 'none' }), {});
});
test('凭证只允许发往官方白名单，子域/明文/第三方一律拒', () => {
  assert.ok(auth.isAllowedCredentialTarget('https://www.workbuddy.cn/billing/meter'));
  assert.ok(auth.isAllowedCredentialTarget('https://www.codebuddy.cn/v2/billing/meter'));
  assert.ok(!auth.isAllowedCredentialTarget('https://evil.example.com/'));
  assert.ok(!auth.isAllowedCredentialTarget('https://www.workbuddy.cn.evil.com/'));
  assert.ok(!auth.isAllowedCredentialTarget('http://www.workbuddy.cn/'));
  assert.ok(!auth.isAllowedCredentialTarget('not a url'));
  assert.throws(() => auth.assertAllowedCredentialTarget('https://evil.example.com/'), /不在允许列表/);
});
