import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as crypto from 'node:crypto';
import { decryptSecret, extractAccessToken, readWindowsKey } from '../crypto';
import { readValueByKeyMatch } from '../sqlite-reader';
import { CredentialResult } from './types';

const execFileAsync = promisify(execFile);

/**
 * CodeBuddy 会话在宿主 SecretStorage 里的键名。两家不一样，按序取第一个有值的：
 *  - VS Code / Trae / Trae CN：`Tencent-Cloud.coding-copilot.new.accessToken`
 *  - 官方 CodeBuddy CN IDE：`planning-genie.new.accessTokencn`
 * 两者在 state.vscdb 里的形状都是 `secret://{"extensionId":"tencent-cloud.coding-copilot","key":"<键名>"}`。
 */
const SECRET_KEYS = ['Tencent-Cloud.coding-copilot.new.accessToken', 'planning-genie.new.accessTokencn'];

export interface HostStorage {
  /** 宿主产品目录名（Code / Trae CN / CodeBuddy CN …）；macOS 钥匙串条目名要用它 */
  product: string;
  dbPath: string;
  localStatePath?: string;
}

/**
 * 当前宿主的登录态文件位置：跑在哪个编辑器里就只读哪个编辑器的登录态。
 * 由本扩展自己的 globalStorage 目录（`<userData>/User/globalStorage/<扩展 id>`）反推宿主 User 目录，
 * 既不猜 appName 与目录名的对应关系，也不可能读到别的编辑器。
 */
export function currentHostStorage(globalStorageFsPath: string): HostStorage {
  const globalStorageDir = path.dirname(globalStorageFsPath);
  const userDataDir = path.dirname(path.dirname(globalStorageDir));
  return {
    product: path.basename(userDataDir),
    dbPath: path.join(globalStorageDir, 'state.vscdb'),
    localStatePath: process.platform === 'win32' ? path.join(userDataDir, 'Local State') : undefined
  };
}

/**
 * 失败原因里可能带本机路径与用户名（用户常整段截图求助，那串会一起漏出去），
 * 统一把 home / APPDATA 前缀换成 ~。
 */
function redact(text: string): string {
  const bases = [process.env.APPDATA, os.homedir()].filter((b): b is string => !!b && b.length > 1);
  let out = text;
  for (const base of bases) {
    out = out.split(base).join('~');
  }
  return out;
}

/** 用 Node 内置 node:sqlite 读取（Node 22.5+；宿主未启用则抛错） */
function readValueViaNodeSqlite(dbPath: string, key: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite');
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(`select value from ItemTable where key like '%${key}"}%'`).get();
      return row?.value != null ? String(row.value) : undefined;
    } finally {
      db.close?.();
    }
  } catch {
    return undefined;
  }
}

/** 用系统 sqlite3 命令读取（macOS / 多数 Linux 自带；Windows 通常没有） */
async function readValueViaCli(dbPath: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('sqlite3', [dbPath, `select value from ItemTable where key like '%${key}"}%'`], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000
    });
    const raw = String(stdout).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 依次尝试三种方式读取 state.vscdb 里的密文原文，任一命中即返回：
 * 官方 node:sqlite → 系统 sqlite3 命令 → 内置最小解析器（Windows 上通常走这条）。
 */
async function readSecretRaw(dbPath: string, key: string): Promise<string | undefined> {
  if (!fs.existsSync(dbPath)) return undefined;
  const viaNode = readValueViaNodeSqlite(dbPath, key);
  if (viaNode) return viaNode;
  const viaCli = await readValueViaCli(dbPath, key);
  if (viaCli) return viaCli;
  return readValueByKeyMatch(dbPath, (k) => k.includes(key));
}

async function readEncryptedSecret(dbPath: string): Promise<Buffer | undefined> {
  for (const key of SECRET_KEYS) {
    const raw = (await readSecretRaw(dbPath, key))?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.data)) return Buffer.from(parsed.data);
    } catch {
      /* 非常规数据，换下一个键名 */
    }
  }
  return undefined;
}

/** 钥匙串里 safeStorage 的密钥：服务名/账号名都带宿主产品名，密钥由 PBKDF2 派生（实测派 1003 轮） */
async function readMacKey(product: string): Promise<Buffer | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', `${product} Safe Storage`, '-a', `${product} Key`, '-w'],
      // 首次会弹系统授权框（可能要求输入开机密码），给足等待时间但不无限挂起
      { timeout: 180000 }
    );
    const password = String(stdout).trim();
    if (!password) return undefined;
    return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  } catch {
    return undefined;
  }
}

export async function readAutoToken(host: HostStorage | undefined): Promise<CredentialResult> {
  if (!host) return { note: 'current host storage unavailable' };
  if (!fs.existsSync(host.dbPath)) return { note: 'no CodeBuddy session found in the current editor' };
  try {
    const enc = await readEncryptedSecret(host.dbPath);
    if (!enc) return { note: 'no CodeBuddy session found in the current editor' };
    let key: Buffer | undefined;
    if (process.platform === 'win32') {
      const r = await readWindowsKey(host.localStatePath ?? '');
      if (r.error || !r.key) return { note: redact(r.error ?? 'no key') };
      key = r.key;
    } else if (process.platform === 'darwin') {
      // 钥匙串被拒就立即停下，不做无谓重试（避免连环弹授权框）
      key = await readMacKey(host.product);
      if (!key) return { note: 'keychain access denied' };
    } else {
      return { note: 'auto-read unsupported on this platform; use manual token' };
    }
    const plain = decryptSecret(enc, key);
    if (!plain) return { note: 'failed to decrypt session' };
    const token = extractAccessToken(plain);
    return token ? { token } : { note: 'accessToken not found in session' };
  } catch (e) {
    return { note: redact(String((e as Error)?.message ?? e)).slice(0, 120) };
  }
}
