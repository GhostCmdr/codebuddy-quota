import { Auth, assertAllowedCredentialTarget, authHeaders, invalidateAuth, isInternationalAuth, preferredBillingBase, resolveBillingBase } from './auth';

export interface CreditPack {
  name: string;
  remain: number;
  limit: number;
  unlimited: boolean;
  /** 套餐包（订阅配额）与赠送/加量包的区别：赠送包的 SubProductCode 带 bonus_pack */
  plan: boolean;
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

/** 业务码统一成数字：接口偶尔会把 code 包成字符串，"0" 不能当业务失败 */
function apiCode(json: unknown): number {
  const code = (json as any)?.code;
  if (typeof code === 'number') return code;
  if (typeof code === 'string' && code.trim() !== '') {
    const n = Number(code);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function attrValue(a: any, key: string): string | undefined {
  const hit = (a?.AccountAttributes ?? []).find((x: any) => x?.Key === key);
  return typeof hit?.Value === 'string' && hit.Value ? hit.Value : undefined;
}

/**
 * 包的显示名：网页端不直接用接口的 PackageName（那是一长串内部产品名），
 * 而是按积分来源翻译——签到叫「Buddy 加油站签到」、growth_* 统计成「成长计划奖励」、
 * 套餐配额显示「基础积分」。认不出的来源回落接口名，不瞎猜。
 */
function displayPackName(a: any): string {
  const raw = typeof a.PackageName === 'string' && a.PackageName.trim() ? a.PackageName : '-';
  const src = attrValue(a, 'grantSource');
  if (src === 'daily_checkin') return 'Buddy 加油站签到';
  if (src?.startsWith('growth_')) return '成长计划奖励';
  const sub = typeof a.SubProductCode === 'string' ? a.SubProductCode : '';
  if (sub && !/bonus_pack/i.test(sub)) return '基础积分';
  // 认不出的来源回落接口名；接口名统一带「CodeBuddy个人版」/「CodeBuddy个人」前缀，展示时去掉
  const stripped = raw.replace(/^CodeBuddy个人版?/, '').trim();
  return stripped || raw;
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
    const name = displayPackName(a);
    // 套餐包判据：SubProductCode 存在且不带 bonus_pack。字段缺失时按「非套餐」算——
    // 否则国际版之类没有该字段的响应会让每一行都挂上「套餐内」标签
    const plan = !!a.SubProductCode && !/bonus_pack/i.test(String(a.SubProductCode));
    // 定额包：容量为正；不限量包：容量字段非正（腾讯云口径未确认，防御式判定）。
    // 只要出现一个不限量包，整体就按不限量算：额度用不完，再报「有限部分还剩几成」没有意义。
    if (s > 0) {
      hasFinite = true;
      remain += r;
      total += s;
      // 空包也返回：分母本来就要算它，展示层再决定这一行显不显示
      packs.push({ name, remain: r, limit: s, unlimited: false, plan, expireTime: a.CycleEndTime });
    } else {
      hasUnlimited = true;
      packs.push({ name, remain: r, limit: s, unlimited: true, plan, expireTime: a.CycleEndTime });
    }
  }
  // 一个包都没有 = 账号没切到积分计费（或返回结构变了）。此时显示 0/0 会把「没数据」伪装成「没额度」
  if (!hasFinite && !hasUnlimited) {
    throw new Error('账号没有任何积分包，可能未切换到积分计费模式');
  }
  packs.sort((x, y) => (x.expireTime || '9999').localeCompare(y.expireTime || '9999'));
  return { remain, total, unlimited: hasUnlimited, packs };
}

export function shapeCheckinStatus(json: unknown): 'claimed' | 'unclaimed' {
  return (json as any)?.data?.today_checked_in === true ? 'claimed' : 'unclaimed';
}

export function shapeBuddyStatus(json: unknown): BuddyStatus | null {
  if (apiCode(json) !== 0) return null;
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
  const cut = out.replace(WHITESPACE_RE, ' ').trim().slice(0, max);
  // 截断点落在代理对中间时丢掉半个字符，别把 U+FFFD 摆到日志里
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
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

function billingBase(auth: Auth): string {
  return preferredBillingBase(auth);
}

/**
 * 国内站要按包编码白名单过滤；国际站的包编码体系不同，带上国内的编码会被过滤成 0 条，
 * 所以国际站不带 PackageCodes（实测能正常返回该账号的积分包）。
 */
function usageBody(pageSize: number, auth: Auth): Record<string, unknown> {
  const body: Record<string, unknown> = {
    PageNumber: 1, PageSize: pageSize, ProductCode: 'p_tcaca', Status: [0, 3], OnlyValidPeriod: true, NeedInUsage: true
  };
  if (!isInternationalAuth(auth)) body.PackageCodes = PACKAGE_CODES;
  return body;
}

async function probeBillingBase(auth: Auth, base: string): Promise<boolean> {
  try {
    const resp = await authFetch(`${base}/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(base),
      body: JSON.stringify(usageBody(1, auth))
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
  const resp = await authFetch(`${base}/billing/meter/get-user-resource`, { method: 'POST', headers: billingHeaders(base), body: JSON.stringify(usageBody(200, auth)) }, auth);
  if (!resp.ok) throw apiError(`请求积分接口返回 HTTP ${resp.status}`, { httpStatus: resp.status });
  const json: any = await resp.json();
  // HTTP 200 也可能是业务失败：这时 data 是空的，直接当成功会把「取数失败」显示成 0/0
  const code = apiCode(json);
  if (Number.isFinite(code) && code !== 0) {
    throw apiError(`积分接口返回业务错误码 ${code}`, { remoteBody: JSON.stringify(json), httpStatus: resp.status });
  }
  return shapeUsage(json);
}

export async function fetchCheckinStatus(auth: Auth): Promise<'claimed' | 'unclaimed' | 'unknown'> {
  const base = billingBase(auth);
  const resp = await authFetch(`${base}/billing/meter/checkin-status`, { method: 'POST', headers: billingHeaders(base), body: '{}' }, auth);
  const json = await resp.json().catch(() => null);
  if (apiCode(json) === 10001) return 'claimed';
  if (!resp.ok) return 'unknown';
  return shapeCheckinStatus(json);
}

export async function doCheckin(auth: Auth): Promise<CheckinResult> {
  const base = billingBase(auth);
  const resp = await authFetch(`${base}/billing/meter/daily-checkin`, { method: 'POST', headers: billingHeaders(base), body: '{}' }, auth);
  const json = await resp.json().catch(() => null);
  // 10001 = 今天已经领过。良性结果：不算失败，也不该让上层天天重试。
  if (apiCode(json) === 10001) return { state: 'claimed' };
  if (!resp.ok) return { state: 'unknown', error: `HTTP_${resp.status}` };
  if (apiCode(json) === 0) return { state: 'claimed', credit: json?.data?.credit, freshlyClaimed: true };
  const st = await fetchCheckinStatus(auth);
  return st === 'claimed' ? { state: 'claimed' } : { state: 'unknown', error: `code=${json?.code ?? ''}` };
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
    if (apiCode(j) === 0) return { claimed: true, credit: j?.data?.credit };
    const msg = typeof j?.msg === 'string' ? j.msg : '';
    if (/no unclaimed/i.test(msg)) return { credit: 0 };
    return { error: msg.trim() ? safeSnippet(msg) : `HTTP_${j?.code ?? 'unknown'}` };
  } catch (e) {
    if (isAuthError(e)) throw e;
    return { error: safeSnippet(String((e as Error)?.message ?? e)) };
  }
}

export async function departBuddy(auth: Auth, locationId = 1): Promise<{ hours?: number; error?: string }> {
  try {
    const j = await callTravel(auth, 'depart', 'POST', JSON.stringify({ location_id: locationId }));
    if (apiCode(j) === 0) {
      let h = (await fetchBuddyStatus(auth))?.durationHours;
      if (h == null) {
        const dh = j?.data?.duration_hours ?? j?.data?.duration;
        if (typeof dh === 'number' && dh > 0) h = dh;
      }
      return { hours: h != null && h > 0 ? h : 0 };
    }
    const msg = typeof j?.msg === 'string' ? j.msg : '';
    return { error: msg.trim() ? safeSnippet(msg) : `HTTP_${j?.code ?? 'unknown'}` };
  } catch (e) {
    if (isAuthError(e)) throw e;
    return { error: safeSnippet(String((e as Error)?.message ?? e)) };
  }
}

export async function fetchTravelRewardCredit(auth: Auth, departAt?: number): Promise<number | undefined> {
  try {
    const j = await callTravel(auth, 'records?page=1&page_size=20', 'GET');
    if (apiCode(j) !== 0) return undefined;
    const recs: any[] = j?.data?.records ?? [];
    if (!recs.length) return undefined;
    const hit = departAt != null ? recs.find((r: any) => r.depart_at === departAt) : undefined;
    const c = (hit ?? recs[0])?.reward_credit;
    return typeof c === 'number' ? c : undefined;
  } catch {
    return undefined;
  }
}
