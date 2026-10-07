export function pctOf(remain: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((remain / total) * 100)));
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
export function fmtCredits(value: number): string {
  const n = Math.round(value);
  if (!Number.isFinite(n)) return '-';
  if (n < 10000) return fmtInt(n);
  const scale = n < 1e8 ? { div: 1e4, unit: 'w' } : { div: 1e8, unit: '亿' };
  const scaled = n / scale.div;
  return fmtDecimal(scaled, scaled >= 1000 ? 0 : 1) + scale.unit;
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
