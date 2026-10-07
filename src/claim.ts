import { Auth } from './auth';
import { BuddyStatus, CheckinResult } from './api';
import { shouldCheckin, todayString } from './checkin';

export interface CheckinApi {
  status(auth: Auth): Promise<'claimed' | 'unclaimed' | 'unknown'>;
  checkin(auth: Auth): Promise<CheckinResult>;
}

export interface BuddyApi {
  status(auth: Auth): Promise<BuddyStatus | null>;
  claim(auth: Auth): Promise<{ claimed?: boolean; credit?: number; error?: string }>;
  depart(auth: Auth): Promise<{ hours?: number; error?: string }>;
  rewardCredit(auth: Auth, departAt?: number): Promise<number | undefined>;
}

/**
 * 日期守卫的存储口子：按账号分桶，由调用方落到 globalState，
 * 让「今天已经领过」这件事跨重启有效。不传则退化成「每次都尝试」（测试用）。
 */
export interface DayGuard {
  lastDate(): string | undefined;
  record(day: string): Promise<void>;
}

export interface CheckinOutcome {
  state: 'claimed' | 'unclaimed' | 'unknown';
  freshlyClaimed?: boolean;
  credit?: number;
  /** 本地守卫说今天已经领过，这次连请求都没发 */
  skippedByGuard?: boolean;
  error?: string;
}

/**
 * 领一次签到。只有在成功（含服务端说今天已领过）时才写日期守卫，
 * 失败保持原样，让下一次刷新自然重试。
 */
export async function ensureCheckin(auth: Auth, api: CheckinApi, guard?: DayGuard): Promise<CheckinOutcome> {
  const day = todayString();
  const status = await api.status(auth);
  if (status === 'claimed') return { state: 'claimed' };
  // 本地守卫优先于 status 字段：那字段会给出前后矛盾的值，而服务端对重复领取幂等，
  // 所以「今天成功过一次」就不再发请求。
  if (guard && !shouldCheckin(guard.lastDate(), day)) return { state: 'claimed', skippedByGuard: true };
  if (status !== 'unclaimed') return { state: 'unknown' };
  const r = await api.checkin(auth);
  if (r.state === 'claimed') {
    await guard?.record(day);
    return { state: 'claimed', freshlyClaimed: r.freshlyClaimed, credit: r.credit };
  }
  return { state: r.state, error: r.error };
}

let lastBuddyClaimKey = '';
let lastBuddyWasTraveling = false;

export function resetBuddyState(): void {
  lastBuddyClaimKey = '';
  lastBuddyWasTraveling = false;
}

export async function ensureBuddy(
  auth: Auth,
  api: BuddyApi | undefined,
  enabled: boolean,
  guard?: DayGuard
): Promise<{ claimedCredit?: number; departedHours?: number; error?: string } | undefined> {
  if (!enabled || !api) return undefined;
  const status = await api.status(auth);
  if (!status) return undefined;
  const result: { claimedCredit?: number; departedHours?: number; error?: string } = {};
  const isTraveling = status.state === 'traveling';
  const backFromTravel = status.state != null && !isTraveling;
  const travelJustEnded = lastBuddyWasTraveling && !isTraveling;
  const travelKey = String(status.departAt ?? status.arriveAt ?? status.state ?? '');
  if (backFromTravel && (travelJustEnded || travelKey !== lastBuddyClaimKey)) {
    try {
      const c = await api.claim(auth);
      if (c.error) {
        result.error = c.error;
      } else {
        let credit = c.credit;
        if (c.claimed && !((credit ?? 0) > 0)) credit = await api.rewardCredit(auth, status.departAt);
        result.claimedCredit = credit ?? 0;
        lastBuddyClaimKey = travelKey;
      }
    } catch {
      result.error = 'claim failed';
    }
  }
  const today = todayString();
  const canDepart = backFromTravel && !status.dailyLimitReached;
  if (canDepart && shouldCheckin(guard?.lastDate(), today)) {
    try {
      const d = await api.depart(auth);
      if (d.error) result.error = result.error ?? d.error;
      else result.departedHours = d.hours ?? 0;
      await guard?.record(today);
    } catch {
      result.error = result.error ?? 'depart failed';
    }
  }
  const st2 = await api.status(auth);
  lastBuddyWasTraveling = (st2?.state ?? status.state) === 'traveling';
  return result;
}
