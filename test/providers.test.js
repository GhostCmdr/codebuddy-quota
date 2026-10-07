const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vh = require('../out/providers/vscodeHost.js');

test('currentHostStorage 由本扩展的 globalStorage 位置反推当前宿主的文件', () => {
  const gs = path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'ghostcmdr.codebuddy-quota');
  const s = vh.currentHostStorage(gs);
  assert.strictEqual(s.product, 'Code');
  assert.strictEqual(s.dbPath, path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'state.vscdb'));
  if (process.platform === 'win32') {
    assert.strictEqual(s.localStatePath, path.join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Code', 'Local State'));
  } else {
    assert.strictEqual(s.localStatePath, undefined);
  }
});
test('readAutoToken 拿不到宿主库时返回 note，不抛错也不去别的目录找', async () => {
  const missing = await vh.readAutoToken(undefined);
  assert.strictEqual(missing.token, undefined);
  assert.ok(missing.note);
  const absent = await vh.readAutoToken({ product: 'Code', dbPath: path.join(__dirname, '_no_such_host', 'state.vscdb') });
  assert.strictEqual(absent.token, undefined);
  assert.match(absent.note, /no CodeBuddy session found/);
});

/**
 * 官方 CodeBuddy CN IDE 的键名是 planning-genie.new.accessTokencn，与 VS Code 系不同。
 * 造一个只含该键名的库：只要还能走到解密那步（而不是「没找到会话」），就说明键名匹配上了。
 */
test('ReadAutoToken 认得官方 CodeBuddy CN 的键名', async (t) => {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    t.skip('本机 Node 没有 node:sqlite');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbq-host-'));
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const key = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}';
  // 一个形状合法但解不开的 v10 密文；只验证「键名被认出来」这件事
  db.prepare('insert into ItemTable (key, value) values (?, ?)').run(key, JSON.stringify({ type: 'Buffer', data: Array(64).fill(7) }));
  db.close();
  try {
    const r = await vh.readAutoToken({ product: 'CodeBuddy CN', dbPath, localStatePath: path.join(dir, 'Local State') });
    assert.strictEqual(r.token, undefined);
    assert.doesNotMatch(r.note, /no CodeBuddy session found/, `键名没被认出来：${r.note}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
