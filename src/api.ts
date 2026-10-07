import { Auth, assertAllowedCredentialTarget, authHeaders, invalidateAuth, getBillingBase, resolveBillingBase } from './auth';

export interface CreditPack {
  name: string;
  remain: number;
  limit: number;
  unlimited: boolean;
  expireTime?: string;
}

export interface CreditsSummary {
  remain: number;
  total: number;
  unlimited: boolean;
  packs: CreditPack[];
}

export interface CheckinResult {
  state: 'claimed' | 'unclaimed' | 'unknown';
  error?: string;
  credit?: number;
  freshlyClaimed?: boolean;
  /** 服务端说今天已经领过（业务码 10001）：良性结果，调用方据此记下当天不再重试 */
  alreadyClaimed?: boolean;
}

export interface BuddyStatus {
  state?: string;
  departAt?: number;
  arriveAt?: number;
  serverNow?: number;
  durationHours?: number;
  dailyLimitReached?: boolean;
}

function num(s: unknown): number {
  const n = parseFloat(String(s ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

export function shapeUsage(json: unknown): CreditsSummary {
  const accounts: any[] = (json as any)?.data?.Response?.Data?.Accounts ?? [];
  let remain = 0;
  let total = 0;
  let hasFinite = false;
  let hasUnlimited = false;
  const packs: CreditPack[] = [];
  for (const a of accounts) {
    const cr = a.CycleCapacityRemainPrecise;
    const cs = a.CycleCapacitySizePrecise;
    let r: number;
    let s: number;
    if (cr != null && cs != null) {
      r = num(cr);
      s = num(cs);
    } else {
      r = num(a.CapacityRemainPrecise);
      s = num(a.CapacitySizePrecise);
    }
    // 套餐名可能是数字/对象：非字符串一律回落，否则它会一路进到 SVG 渲染并抛 TypeError
    const name = typeof a.PackageName === 'string' && a.PackageName.trim() ? a.PackageName : '-';
    // 定额包：容量为正；不限量包：容量字段非正（腾讯云口径未确认，防御式判定）。
    // 定额与不限量并存时按定额部分算占比（对齐 traecn），不误报 100%。
    if (s > 0) {
      hasFinite = true;
      remain += r;
      if (r > 0) {
        total += s;
        packs.push({ name, remain: r, limit: s, unlimited: false, expireTime: a.CycleEndTime });
      }
    } else {
      hasUnlimited = true;
      packs.push({ name, remain: r, limit: s, unlimited: true, expireTime: a.CycleEndTime });
    }
  }
  // 一个包都没有 = 账号没切到积分计费（或返回结构变了）。此时显示 0/0 会把「没数据」伪装成「没额度」
  if (!hasFinite && !hasUnlimited) {
    throw new Error('账号没有任何积分包，可能未切换到积分计费模式');
  }
  packs.sort((x, y) => (x.expireTime ?? '9999').localeCompare(y.expireTime ?? '9999'));
  return { remain, total, unlimited: !hasFinite && hasUnlimited, packs };
}

export function shapeCheckinStatus(json: unknown): 'claimed' | 'unclaimed' {
  return (json as any)?.data?.today_checked_in === true ? 'claimed' : 'unclaimed';
}

export function shapeBuddyStatus(json: unknown): BuddyStatus | null {
  if ((json as any)?.code !== 0) return null;
  const d = (json as any)?.data ?? {};
  return {
    state: d.state,
    departAt: d.depart_at,
    arriveAt: d.arrive_at,
    serverNow: d.server_now,
    durationHours: d.duration_hours ?? d.location?.duration_hours,
    dailyLimitReached: d.daily_limit_reached
  };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PACKAGE_CODES = ['TCACA_code_008_cfWoLwvjU4', 'TCACA_code_009_0XmEQc2xOf', 'TCACA_code_038_OhvqZtiPKr', 'TCACA_code_007_nzdH5h4Nl0', 'TCACA_code_028_NtpWi0jzXs', 'TCACA_code_029_6wCGEWquYy', 'TCACA_code_030_BjSt89qTvr'];
const TRAVEL_BASE = 'https://www.workbuddy.cn';

/** 成对出现就能拼出 Markdown 链接/图片，单独出现也能改排版 */
const UI_UNSAFE_CHARS = '[]()*~#!|<>`\\';
const URL_RE = /https?:\/\/\S+/gi;
/** 零宽与双向控制符能让链接显示与现实不一致，且不属于 \s */
const CONTROL_RE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064]', 'g');
const WHITESPACE_RE = /\s+/g;

/**
 * 远程文本进任何面向用户的载体前的统一净化。裸 URL 会被编辑器认成可点链接，
 * `[文字](链接)` 与 `![图](链接)` 分别是钓鱼外链和悬停代发请求，所以整段抹掉，
 * 最后截断。抹完只剩可读的文字线索，不含任何可构造的链接语法。
 */
export function safeSnippet(text: string, max = 80): string {
  let out = text.replace(URL_RE, '[链接已隐去]').replace(CONTROL_RE, '');
  for (const ch of UI_UNSAFE_CHARS) {
    out = out.split(ch).join('');
  }
  return out.replace(WHITESPACE_RE, ' ').trim().slice(0, max);
}

export interface ApiError extends Error {
  /** 认证类失败的分派标记，调用方据此选用户文案 */
  code?: 'NO_CREDENTIALS' | 'AUTH_EXPIRED';
  /** 接口正文线索，只允许写进输出面板 */
  remoteDetail?: string;
  /** HTTP 状态码，用于区分「真 401」与正文里恰好出现 401 */
  httpStatus?: number;
}

/**
 * 面向用户的错误消息只带接口名与状态码，不带正文——正文会进状态栏 tooltip 和错误 toast，
 * 那两处都按 Markdown 渲染。正文另挂 remoteDetail，只由输出面板写。
 */
export function apiError(message: string, opts: { remoteBody?: string; httpStatus?: number; code?: ApiError['code'] } = {}): ApiError {
  const err = new Error(message) as ApiError;
  if (opts.remoteBody) {
    const snippet = safeSnippet(opts.remoteBody);
    if (snippet) err.remoteDetail = snippet;
  }
  if (typeof opts.httpStatus === 'number') err.httpStatus = opts.httpStatus;
  if (opts.code) err.code = opts.code;
  return err;
}

/** 接口层自己抛出的认证类错误，用于在吞错误的包装函数里原样放行 */
function isAuthError(err: unknown): boolean {
  const code = (err as ApiError)?.code;
  return code === 'NO_CREDENTIALS' || code === 'AUTH_EXPIRED';
}

async function authFetch(url: string, init: RequestInit, auth: Auth): Promise<Response> {
  // 发送边界的最后一道断言：凭证只允许发往官方站点，防止以后新增取源时漏掉归一化
  assertAllowedCredentialTarget(url);
  for (let i = 0; i < 2; i++) {
    if (auth.mode === 'none') throw apiError('未找到登录凭据', { code: 'NO_CREDENTIALS' });
    const headers = { ...(init.headers ?? {}), ...authHeaders(auth), 'user-agent': UA };
    const resp = await fetch(url, { ...init, headers });
    if (resp.status === 401 || resp.status === 403) {
      invalidateAuth(true);
      continue;
    }
    return resp;
  }
  throw apiError('登录态被服务端拒绝（HTTP 401/403）', { code: 'AUTH_EXPIRED', httpStatus: 401 });
}

function billingHeaders(base: string): Record<string, string> {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    origin: base,
    referer: `${base.replace(/\/v2$/, '')}/profile/plans-usage`,
    'x-client-platform': 'web'
  };
}

function travelHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    origin: TRAVEL_BASE,
    referer: `${TRAVEL_BASE}/profile/growth-center`,
    'x-client-platform': 'web'
  };
}

function billingBase(): string {
  return getBillingBase() ?? 'https://www.workbuddy.cn';
}

export async function probeBillingBase(auth: Auth, base: string): Promise<boolean> {
  try {
    const resp = await authFetch(`${base}/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(base),
      body: JSON.stringify({ PageNumber: 1, PageSize: 1, ProductCode: 'p_tcaca', Status: [0, 3], OnlyValidPeriod: true, PackageCodes: PACKAGE_CODES, NeedInUsage: true })
    }, auth);
    return resp.ok;
  } catch {
    return false;
  }
}

async function ensureBase(auth: Auth): Promise<string> {
  return resolveBillingBase(auth, (b) => probeBillingBase(auth, b));
}

export async function fetchUsage(auth: Auth): Promise<CreditsSummary> {
  const base = await ensureBase(auth);
  const body = { PageNumber: 1, PageSize: 200, ProductCode: 'p_tcaca', Status: [0, 3], OnlyValidPeriod: true, PackageCodes: PACKAGE_CODES, NeedInUsage: true };
  const resp = await authFetch(`${base}/billing/meter/get-user-resource`, { method: 'POST', headers: billingHeaders(base), body: JSON.stringify(body) }, auth);
  if (!resp.ok) throw apiError(`请求积分接口返回 HTTP ${resp.status}`, { httpStatus: resp.status });
  const json: any = await resp.json();
  // HTTP 200 也可能是业务失败：这时 data 是空的，直接当成功会把「取数失败」显示成 0/0
  if (typeof json?.code === 'number' && json.code !== 0) {
    throw apiError(`积分接口返回业务错误码 ${json.code}`, { remoteBody: JSON.stringify(json), httpStatus: resp.status });
  }
  return shapeUsage(json);
}

export async function fetchCheckinStatus(auth: Auth): Promise<'claimed' | 'unclaimed' | 'unknown'> {
  const base = billingBase();
  const resp = await authFetch(`${base}/billing/meter/checkin-status`, { method: 'POST', headers: billingHeaders(base), body: '{}' }, auth);
  const json = await resp.json().catch(() => null);
  if (json?.code === 10001) return 'claimed';
  if (!resp.ok) return 'unknown';
  return shapeCheckinStatus(json);
}

export async function doCheckin(auth: Auth): Promise<CheckinResult> {
  const base = billingBase();
  const resp = await authFetch(`${base}/billing/meter/daily-checkin`, { method: 'POST', headers: billingHeaders(base), body: '{}' }, auth);
  const json = await resp.json().catch(() => null);
  // 10001 = 今天已经领过。良性结果：不算失败，也不该让上层天天重试。
  if (json?.code === 10001) return { state: 'claimed', alreadyClaimed: true };
  if (!resp.ok) return { state: 'unknown', error: `HTTP_${resp.status}` };
  if (json?.code === 0) return { state: 'claimed', credit: json?.data?.credit, freshlyClaimed: true };
  const st = await fetchCheckinStatus(auth);
  return st === 'claimed' ? { state: 'claimed', alreadyClaimed: true } : { state: 'unknown', error: `code=${json?.code ?? ''}` };
}

async function callTravel(auth: Auth, sub: string, method: string, body?: string): Promise<any> {
  const init: RequestInit = { method, headers: travelHeaders() };
  if (body !== undefined) init.body = body;
  const resp = await authFetch(`${TRAVEL_BASE}/activity/growth/buddy/travel/${sub}`, init, auth);
  return resp.json().catch(() => ({}));
}

export async function fetchBuddyStatus(auth: Auth): Promise<BuddyStatus | null> {
  try {
    return shapeBuddyStatus(await callTravel(auth, 'status', 'GET'));
  } catch {
    return null;
  }
}

export async function claimBuddy(auth: Auth): Promise<{ claimed?: boolean; credit?: number; error?: string }> {
  try {
    const j = await callTravel(auth, 'claim', 'POST', '{}');
    if (j?.code === 0) return { claimed: true, credit: j?.data?.credit };
    const msg = typeof j?.msg === 'string' ? j.msg : '';
    if (/no unclaimed/i.test(msg)) return { credit: 0 };
    return { error: msg.trim() ? safeSnippet(msg) : `HTTP_${j?.code ?? ''}` };
  } catch (e) {
    if (isAuthError(e)) throw e;
    return { error: safeSnippet(String((e as Error)?.message ?? e)) };
  }
}

export async function departBuddy(auth: Auth, locationId = 1): Promise<{ hours?: number; error?: string }> {
  try {
    const j = await callTravel(auth, 'depart', 'POST', JSON.stringify({ location_id: locationId }));
    if (j?.code === 0) {
      let h = (await fetchBuddyStatus(auth))?.durationHours;
      if (h == null) {
        const dh = j?.data?.duration_hours ?? j?.data?.duration;
        if (typeof dh === 'number' && dh > 0) h = dh;
      }
      return { hours: h != null && h > 0 ? h : 0 };
    }
    const msg = typeof j?.msg === 'string' ? j.msg : '';
    return { error: msg.trim() ? safeSnippet(msg) : `HTTP_${j?.code ?? ''}` };
  } catch (e) {
    if (isAuthError(e)) throw e;
    return { error: safeSnippet(String((e as Error)?.message ?? e)) };
  }
}

export async function fetchTravelRewardCredit(auth: Auth, departAt?: number): Promise<number | undefined> {
  try {
    const j = await callTravel(auth, 'records?page=1&page_size=20', 'GET');
    if (j?.code !== 0) return undefined;
    const recs: any[] = j?.data?.records ?? [];
    if (!recs.length) return undefined;
    const hit = departAt != null ? recs.find((r: any) => r.depart_at === departAt) : undefined;
    const c = (hit ?? recs[0])?.reward_credit;
    return typeof c === 'number' ? c : undefined;
  } catch {
    return undefined;
  }
}
