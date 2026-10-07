const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const c = require('../out/crypto.js');
function gcm(plain, key) {
  const n = crypto.randomBytes(12);
  const ci = crypto.createCipheriv('aes-256-gcm', key, n);
  const b = Buffer.concat([ci.update(plain, 'utf8'), ci.final()]);
  return Buffer.concat([Buffer.from('v10'), n, b, ci.getAuthTag()]);
}
test('decryptV10Gcm roundtrip', () => {
  const k = crypto.randomBytes(32);
  const p = '{"accessToken":"a.b.c"}';
  assert.strictEqual(c.decryptV10Gcm(gcm(p, k), k), p);
});
test('decryptV10Cbc roundtrip', () => {
  const k = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const ci = crypto.createCipheriv('aes-128-cbc', k, iv);
  const b = Buffer.concat([ci.update('hi', 'utf8'), ci.final()]);
  assert.strictEqual(c.decryptV10Cbc(Buffer.concat([Buffer.from('v10'), iv, b]), k), 'hi');
});
test('decryptSecret 非v10前缀 undefined', () => {
  assert.strictEqual(c.decryptSecret(Buffer.from('v11x'), crypto.randomBytes(32)), undefined);
});
test('extractAccessToken 正则提取', () => {
  assert.strictEqual(c.extractAccessToken('x{"accessToken":"JWT.V.S"}y'), 'JWT.V.S');
  assert.strictEqual(c.extractAccessToken('none'), undefined);
});
test('jwtExpiry 解析 exp', () => {
  const p = Buffer.from(JSON.stringify({ exp: 1790000000 })).toString('base64url');
  assert.strictEqual(c.jwtExpiry(`x.${p}.s`), 1790000000 * 1000);
  assert.strictEqual(c.jwtExpiry('no'), undefined);
});
test('parseEncryptedKey 剥 DPAPI 前缀', () => {
  const k = crypto.randomBytes(32);
  const b64 = Buffer.concat([Buffer.from('DPAPI'), k]).toString('base64');
  assert.deepStrictEqual(c.parseEncryptedKey(JSON.stringify({ os_crypt: { encrypted_key: b64 } })).protectedKey, k);
});
test('parseEncryptedKey 缺字段报错', () => {
  const r = c.parseEncryptedKey(JSON.stringify({ os_crypt: {} }));
  assert.ok(r.error);
  assert.strictEqual(r.protectedKey, undefined);
});
test('jwtStringClaim 取昵称，非法/缺失一律 undefined', () => {
  const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  assert.strictEqual(c.jwtStringClaim(jwt({ nickname: 'Ghost' }), 'nickname'), 'Ghost');
  assert.strictEqual(c.jwtStringClaim(jwt({ nickname: '  Ghost  ' }), 'nickname'), 'Ghost');
  assert.strictEqual(c.jwtStringClaim(jwt({ nickname: '' }), 'nickname'), undefined);
  assert.strictEqual(c.jwtStringClaim(jwt({ nickname: 42 }), 'nickname'), undefined);
  assert.strictEqual(c.jwtStringClaim(jwt({ exp: 1 }), 'nickname'), undefined);
  assert.strictEqual(c.jwtStringClaim('not-a-jwt', 'nickname'), undefined);
});
