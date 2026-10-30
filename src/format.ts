export function pctOf(remain: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (remain >= total) return 100;
  return Math.max(0, Math.min(99, Math.round((remain / total) * 100)));
}
function fmtInt(n: number): string { return Math.round(n).toLocaleString('en-US'); }
function fmtDecimal(scaled: number, digits: number): string {
  const fixed = scaled.toFixed(digits);
  const dot = fixed.indexOf('.');
  const intPart = dot < 0 ? fixed : fixed.slice(0, dot);
  const fracPart = dot < 0 ? '' : fixed.slice(dot + 1).replace(/0+$/, '');
  const grouped = Number(intPart).toLocaleString('en-US');
  return fracPart ? `${grouped}.${fracPart}` : grouped;
}
/** 4 位有效数字：1.764w / 17.64w / 176.4w / 1,764w */
function sigDigits(scaled: number): number {
  return scaled >= 1000 ? 0 : scaled >= 100 ? 1 : scaled >= 10 ? 2 : 3;
}
export function fmtCredits(value: number): string {
  const n = Math.round(value);
  if (!Number.isFinite(n)) return '-';
  if (n < 10000) return fmtInt(n);
  let unit = n < 1e8 ? 'w' : '亿';
  let div = unit === 'w' ? 1e4 : 1e8;
  let scaled = n / div;
  let digits = sigDigits(scaled);
  // w 档四舍五入会进位出 10,000w（41px 宽串），这时升级成 亿
  if (unit === 'w' && Number(scaled.toFixed(digits)) >= 10000) {
    unit = '亿';
    div = 1e8;
    scaled = n / div;
    digits = sigDigits(scaled);
  }
  return fmtDecimal(scaled, digits) + unit;
}
/** 悬浮弹窗到期列：到分钟；无到期显示 '-'（对齐 traecn 面板） */
export function formatDateTime(s?: string): string {
  if (!s) return '-';
  const t = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return s;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
