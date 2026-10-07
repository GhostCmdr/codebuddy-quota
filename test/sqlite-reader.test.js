const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const r = require('../out/sqlite-reader.js');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

test('readValueByKeyMatch 从真实库按键取值', { skip: !DatabaseSync }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbq-'));
  const dbPath = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT, value TEXT)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('Tencent-Cloud.coding-copilot.new.accessToken"}', '{"data":["ct"]}');
  db.close();
  const val = r.readValueByKeyMatch(dbPath, (k) => k.includes('Tencent-Cloud.coding-copilot.new.accessToken'));
  assert.strictEqual(val, '{"data":["ct"]}');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('文件不存在返回 undefined', () => {
  assert.strictEqual(r.readValueByKeyMatch('/no/such.db', () => true), undefined);
});
test('文件损坏/被截断时返回 undefined，不把异常抛给上层', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbq-'));
  const dbPath = path.join(dir, 'state.vscdb');
  // 合法魔数 + 声明页大小，但内容被截断，且表头声称有很多 cell —— 解析偏移必然越界
  const buf = Buffer.alloc(200);
  buf.write('SQLite format 3\u0000', 0, 'latin1');
  buf.writeUInt16BE(4096, 16);
  buf[100] = 13; // 叶子表页
  buf.writeUInt16BE(200, 103); // numCells
  fs.writeFileSync(dbPath, buf);
  assert.strictEqual(r.readValueByKeyMatch(dbPath, () => true), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
