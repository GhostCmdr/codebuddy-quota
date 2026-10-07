import * as crypto from 'node:crypto';

/** 与 extension.ts 的日期守卫同口径：'sv' locale 稳定产出 YYYY-MM-DD，不随系统语言变化。 */
export function todayString(now: Date = new Date()): string {
  return now.toLocaleDateString('sv');
}

/**
 * 今天没成功过才该发这次领取。
 *
 * 判据只有本地日期，刻意不看 status 接口的 today_checked_in —— 那是给浮窗展示用的，
 * 服务端对重复领取幂等，所以「今天成功过一次就不再发」既省请求又不会漏领。
 */
export function shouldCheckin(lastSuccessDate: string | undefined, today: string): boolean {
  return lastSuccessDate !== today;
}

/**
 * 兜底补签时刻 = 下一个本地 23:50。签到按本地日切算，当天 23:50 之前失败都还来得及再试；
 * 排到次日凌晨等于放弃当天（那天再不会被动重试）。恰好落在 23:50 或之后则顺延到明天同一刻，
 * 顺带避免 0 延迟的重排风暴。
 */
export function nextCheckinRetryAt(now: Date): Date {
  const sameDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 50, 0, 0);
  if (sameDay.getTime() > now.getTime()) {
    return sameDay;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 50, 0, 0);
}

/**
 * 日期守卫按账号分桶。同一台机器上换账号（手动 Token、或另一个宿主里的登录态）时，
 * 共用一个日期会让先签的那次把另一个挡掉一整天。凭证里没有稳定的 userId，
 * 用 token 摘要分桶：同一份登录态跨重启稳定，换账号必然不同。不落盘原文。
 */
export function accountKeyOf(token: string | undefined): string {
  if (!token) {
    return 'unknown';
  }
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 8);
}
