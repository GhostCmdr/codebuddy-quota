import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ENC_PREFIX = 'v10';

export function decryptV10Gcm(enc: Buffer, key: Buffer): string | undefined {
  if (enc.length <= 3 + 12 + 16) return undefined;
  try {
    const nonce = enc.subarray(3, 15);
    const tag = enc.subarray(enc.length - 16);
    const data = enc.subarray(15, enc.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

export function decryptV10Cbc(enc: Buffer, key: Buffer): string | undefined {
  if (enc.length <= 3 + 16) return undefined;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, enc.subarray(3, 19));
    return Buffer.concat([decipher.update(enc.subarray(19)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

export function decryptSecret(enc: Buffer, key: Buffer): string | undefined {
  if (enc.subarray(0, 3).toString() !== ENC_PREFIX) return undefined;
  return process.platform === 'win32' ? decryptV10Gcm(enc, key) : decryptV10Cbc(enc, key);
}

export function extractAccessToken(plain: string): string | undefined {
  const m = plain.match(/"accessToken":"([^"]+)"/);
  return m?.[1];
}

/** JWT 的第二段（payload）；解不开一律 undefined */
function jwtPayload(token: string): any {
  const segment = token.split('.')[1];
  if (!segment) return undefined;
  try {
    return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function jwtExpiry(token: string): number | undefined {
  const json = jwtPayload(token);
  return typeof json?.exp === 'number' ? json.exp * 1000 : undefined;
}

/** 解析 JWT 的字符串声明（昵称等）；非 JWT、字段缺失或不是非空字符串都返回 undefined */
export function jwtStringClaim(token: string, claim: string): string | undefined {
  const value = jwtPayload(token)?.[claim];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseEncryptedKey(localState: string): { protectedKey?: Buffer; error?: string } {
  try {
    const state = JSON.parse(localState);
    const b64 = state?.os_crypt?.encrypted_key;
    if (typeof b64 !== 'string' || !b64) return { error: 'os_crypt.encrypted_key missing' };
    const raw = Buffer.from(b64, 'base64');
    const prefix = Buffer.from('DPAPI', 'ascii');
    return { protectedKey: raw.subarray(0, 5).equals(prefix) ? raw.subarray(5) : raw };
  } catch (e) {
    return { error: `Local State parse failed: ${String((e as Error)?.message ?? e).slice(0, 100)}` };
  }
}

function powershellPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

/**
 * DPAPI 解出的主机密钥在同一个 profile 里是稳定的：按 encrypted_key 原文缓存，
 * 避免每次刷新都起一次 PowerShell（每次约几百 ms，且会拉高后台 CPU）。
 */
let dpapiCache: { inputB64: string; key: Buffer } | undefined;

export async function readWindowsKey(localStatePath: string): Promise<{ key?: Buffer; error?: string }> {
  let state: string;
  try {
    state = fs.readFileSync(localStatePath, 'utf8');
  } catch {
    return { error: `Local State not found: ${localStatePath}` };
  }
  const parsed = parseEncryptedKey(state);
  if (!parsed.protectedKey) return { error: parsed.error ?? 'encrypted_key missing' };
  const inputB64 = parsed.protectedKey.toString('base64');
  if (dpapiCache?.inputB64 === inputB64) return { key: dpapiCache.key };
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    `$b=[Convert]::FromBase64String('${inputB64}')`,
    '$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($k))'
  ].join(';');
  try {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 60000 });
    const key = Buffer.from(String(stdout).trim(), 'base64');
    if (!key.length) return { error: 'DPAPI returned empty key' };
    dpapiCache = { inputB64, key };
    return { key };
  } catch (e) {
    const detail = String((e as any)?.stderr ?? (e as Error)?.message ?? e).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
    return { error: `DPAPI failed: ${(detail ?? '').slice(0, 120)}` };
  }
}
