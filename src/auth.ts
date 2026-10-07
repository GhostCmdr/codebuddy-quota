import { jwtExpiry } from './crypto';
import { CredentialResult } from './providers/types';
import { readAutoToken, HostStorage } from './providers/vscodeHost';

export interface TokenStore {
  get(): Promise<any>;
  set(v: any): Promise<void>;
}

export interface Auth {
  /** manual = 用保管箱/设置项里的手动 Token；auto = 从当前编辑器读到的登录态；none = 都没拿到 */
  mode: 'auto' | 'manual' | 'none';
  token?: string;
  expiresAt?: number;
  note?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
/** 读宿主保管箱的上限：卡住时不能把整轮刷新永久钉在「刷新中…」 */
const STORE_READ_TIMEOUT_MS = 5000;

/**
 * 给一个 promise 加上限：到点或出错都返回 undefined，让调用方按「没读到」往下走。
 * 宿主的 SecretStorage 是外部实现，可能一直不返回（手动 Token 那条读用了同一套上限）。
 */
function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    const done = (v: T | undefined) => {
      clearTimeout(timer);
      resolve(v);
    };
    p.then(done, () => done(undefined));
  });
}

/**
 * 允许携带凭证访问的基地址，也是探测 billing 端点的候选集。
 * 配置项与自动探测都只从这里取值；api.ts 发送前还会按站点再断言一次。
 */
export const ALLOWED_BILLING_BASES = ['https://www.workbuddy.cn', 'https://www.codebuddy.cn/v2'];

/**
 * 允许携带凭证访问的站点。只认精确 origin，不放开 `*.` 通配：
 * 任意子域（含悬垂 CNAME 的废弃环境）都能收走请求头里的凭证。
 */
const ALLOWED_CREDENTIAL_ORIGINS = new Set(['https://www.workbuddy.cn', 'https://www.codebuddy.cn']);

/** url 的站点是否在白名单内。解不出 URL 一律不放行。 */
export function isAllowedCredentialTarget(url: string): boolean {
  try {
    return ALLOWED_CREDENTIAL_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** 发送凭证前的最后一道断言。凭证明文可读、可被同步，不能让它成为发往任意地址的通道。 */
export function assertAllowedCredentialTarget(url: string): void {
  if (!isAllowedCredentialTarget(url)) {
    throw new Error(`请求目标不在允许列表，已拒绝发送凭证`);
  }
}

let manualToken = '';
let hostStorage: HostStorage | undefined;
let store: TokenStore | undefined;
let cache: Auth | undefined;
let cacheAt = 0;
let autoReadBlocked = false;
let billingBase: string | undefined;

export function configure(opts: { manualToken: string; store: TokenStore; hostStorage?: HostStorage }): void {
  manualToken = (opts.manualToken || '').trim();
  hostStorage = opts.hostStorage;
  store = opts.store;
}

export function invalidateAuth(retryCredential = false): void {
  cache = undefined;
  cacheAt = 0;
  if (retryCredential) autoReadBlocked = false;
  if (store) void store.set(undefined).catch(() => undefined);
}

export function getBillingBase(): string | undefined {
  return billingBase;
}

export function authHeaders(auth: Auth): Record<string, string> {
  return auth.token ? { authorization: `Bearer ${auth.token}` } : {};
}

export async function getAuth(): Promise<Auth> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;
  if (store) {
    const cached = await bounded(store.get(), STORE_READ_TIMEOUT_MS);
    if (cached?.token) {
      const exp = cached.expiresAt ?? jwtExpiry(cached.token);
      if (exp == null || exp > now + REFRESH_MARGIN_MS) {
        cache = { mode: cached.mode ?? 'auto', token: cached.token, expiresAt: exp };
        cacheAt = now;
        return cache;
      }
    }
  }
  if (manualToken) {
    const exp = jwtExpiry(manualToken);
    if (exp == null || exp > now) {
      cache = { mode: 'manual', token: manualToken, expiresAt: exp };
      cacheAt = now;
      return cache;
    }
  }
  if (!autoReadBlocked) {
    const auto: CredentialResult = await readAutoToken(hostStorage);
    if (auto.token) {
      const exp = jwtExpiry(auto.token);
      if (exp == null || exp > now) {
        if (store) await store.set({ token: auto.token, expiresAt: exp, mode: 'auto' }).catch(() => undefined);
        cache = { mode: 'auto', token: auto.token, expiresAt: exp };
        cacheAt = now;
        return cache;
      }
      // 读到了但已过期：不封锁重试（换新登录态后还能救回来），但要说清是过期，别只留一句模糊的没有凭据
      cache = { mode: 'none', note: 'auto token expired' };
      cacheAt = now;
      return cache;
    }
    autoReadBlocked = true;
    cache = { mode: 'none', note: auto.note };
    cacheAt = now;
    return cache;
  }
  cache = { mode: 'none' };
  cacheAt = now;
  return cache;
}

/**
 * 探测哪个 billing 端点可用。候选集就是白名单本身，探测失败一律回落到第一个候选，
 * 不把任意字符串写进 billingBase —— 它会被拼进 URL 连同凭证一起发出去。
 */
export async function resolveBillingBase(auth: Auth, probe: (base: string) => Promise<boolean>): Promise<string> {
  if (billingBase && (await probe(billingBase))) return billingBase;
  for (const b of ALLOWED_BILLING_BASES) {
    if (await probe(b)) {
      billingBase = b;
      return b;
    }
  }
  billingBase = ALLOWED_BILLING_BASES[0];
  return billingBase;
}
