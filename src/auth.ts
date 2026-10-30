import { jwtExpiry, jwtStringClaim } from './crypto';
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
/** 宿主读失败后的重试冷却：别每次调用都去 spawn 解密，但也不能永远不重试（否则手动兜底后回不到自动） */
const AUTO_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
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

/** 国内候选：WorkBuddy 网页端与 CodeBuddy 网页端 */
const CN_BILLING_BASES = ['https://www.workbuddy.cn', 'https://www.codebuddy.cn/v2'];
/** 国际站：CodeBuddy 国际版同一个 billing 接口，路径与参数一致 */
export const INTL_BILLING_BASE = 'https://www.codebuddy.ai/v2';
/**
 * 允许携带凭证访问的站点。只认精确 origin，不放开 `*.` 通配：
 * 任意子域（含悬垂 CNAME 的废弃环境）都能收走请求头里的凭证。
 */
const ALLOWED_CREDENTIAL_ORIGINS = new Set(['https://www.workbuddy.cn', 'https://www.codebuddy.cn', 'https://www.codebuddy.ai']);

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
/** 宿主读失败后的下一次允许重试时刻（0 = 立刻允许） */
let autoRetryAt = 0;
let autoFailNote = '';
/** 各区域已选定的 billing base；按 CN / INTL 分桶，换区域账号不会串用 */
const billingBases = new Map<string, string>();
/** 宿主登录态读取器：默认走 providers，测试里可替换 */
let autoReader: (storage: HostStorage | undefined) => Promise<CredentialResult> = readAutoToken;

export function configure(opts: { manualToken: string; store: TokenStore; hostStorage?: HostStorage; autoReader?: (storage: HostStorage | undefined) => Promise<CredentialResult> }): void {
  manualToken = (opts.manualToken || '').trim();
  hostStorage = opts.hostStorage;
  store = opts.store;
  autoReader = opts.autoReader ?? readAutoToken;
}

export function invalidateAuth(retryCredential = false): void {
  cache = undefined;
  cacheAt = 0;
  if (retryCredential) autoRetryAt = 0;
  if (store) void store.set(undefined).catch(() => undefined);
}

/** 区域策略：auto = 按 token 的 iss 自动判断；cn / intl = 用户强制指定 */
export type RegionPolicy = 'auto' | 'cn' | 'intl';
let regionPolicy: RegionPolicy = 'auto';

/** 设置项 codebuddyquota.region：改了就清掉已探测的 base，下一次取数重新选站点 */
export function setRegionPolicy(policy: unknown): void {
  regionPolicy = policy === 'cn' || policy === 'intl' ? policy : 'auto';
  billingBases.clear();
}

/** token 的 iss 就是账号归属站点：国内是 *.codebuddy.cn / workbuddy.cn，国际版是 codebuddy.ai */
export function isInternationalAuth(auth: Auth): boolean {
  if (regionPolicy !== 'auto') return regionPolicy === 'intl';
  const iss = auth.token ? jwtStringClaim(auth.token, 'iss') ?? '' : '';
  try {
    return new URL(iss).host.endsWith('codebuddy.ai');
  } catch {
    return false;
  }
}

function billingKey(auth: Auth): 'intl' | 'cn' {
  return isInternationalAuth(auth) ? 'intl' : 'cn';
}

function billingCandidates(auth: Auth): string[] {
  return isInternationalAuth(auth) ? [INTL_BILLING_BASE] : CN_BILLING_BASES;
}

export function getBillingBase(auth: Auth): string | undefined {
  return billingBases.get(billingKey(auth));
}

/** 还没探测过时的首选 base：国内沿用现有默认，国际站只有一个候选 */
export function preferredBillingBase(auth: Auth): string {
  return getBillingBase(auth) ?? billingCandidates(auth)[0];
}

export function authHeaders(auth: Auth): Record<string, string> {
  return auth.token ? { authorization: `Bearer ${auth.token}` } : {};
}

function remember(a: Auth): Auth {
  cache = a;
  cacheAt = Date.now();
  return a;
}

/**
 * 取凭证，优先级从高到低：
 *   1. 当前编辑器的登录态——永远优先，切号后下一次读取就跟着变
 *   2. 上一次读到的登录态（只在这次读宿主失败时兜底，仍是同一编辑器的账号）
 *   3. 手动 Token——宿主读不到时的兜底
 *   4. 都没有
 * 读宿主失败进 5 分钟冷却，不会每次调用都去解密；`force=true`（手动刷新）立刻重试，
 * 读回来就自动切回 auto——手动兜底不是单向的死路。
 */
export async function getAuth(force = false): Promise<Auth> {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_TTL_MS) return cache;
  cache = undefined;

  if (force || now >= autoRetryAt) {
    const auto = (await bounded(autoReader(hostStorage), STORE_READ_TIMEOUT_MS)) ?? { note: '读取超时' };
    const exp = auto.token ? jwtExpiry(auto.token) : undefined;
    if (auto.token && (exp == null || exp > now)) {
      autoRetryAt = 0;
      autoFailNote = '';
      if (store) await store.set({ token: auto.token, expiresAt: exp, mode: 'auto' }).catch(() => undefined);
      return remember({ mode: 'auto', token: auto.token, expiresAt: exp });
    }
    autoFailNote = auto.token ? 'auto token expired' : auto.note || 'no auto token';
    autoRetryAt = now + AUTO_RETRY_COOLDOWN_MS;
  }

  if (store) {
    const cached = await bounded(store.get(), STORE_READ_TIMEOUT_MS);
    if (cached?.token && cached.mode !== 'manual') {
      const exp = cached.expiresAt ?? jwtExpiry(cached.token);
      if (exp == null || exp > now) {
        return remember({ mode: 'auto', token: cached.token, expiresAt: exp, note: '宿主登录态读取失败，暂用上次读到的账号' });
      }
    }
  }

  if (manualToken) {
    const exp = jwtExpiry(manualToken);
    if (exp == null || exp > now) {
      return remember({ mode: 'manual', token: manualToken, expiresAt: exp, note: autoFailNote });
    }
  }

  return remember({ mode: 'none', note: autoFailNote });
}

/**
 * 探测哪个 billing 端点可用。候选集按账号区域取自白名单，探测失败一律回落到该区域的第一个候选，
 * 不把任意字符串写进缓存 —— 它会被拼进 URL 连同凭证一起发出去。
 */
export async function resolveBillingBase(auth: Auth, probe: (base: string) => Promise<boolean>): Promise<string> {
  const key = billingKey(auth);
  const cached = billingBases.get(key);
  if (cached && (await probe(cached))) return cached;
  for (const b of billingCandidates(auth)) {
    if (await probe(b)) {
      billingBases.set(key, b);
      return b;
    }
  }
  const fallback = billingCandidates(auth)[0];
  billingBases.set(key, fallback);
  return fallback;
}
