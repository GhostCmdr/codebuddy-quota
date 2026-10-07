import { CreditsSummary } from './api';
import { pctOf, fmtCredits, formatDateTime } from './format';

/* ============================ 通用工具 ============================ */
function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function svgDataUri(svg: string): string {
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/* ====================== 显示宽度 / 截断 / 列宽 ====================== */
const WIDE_RE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;
function charWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x1f300) return 2;
  return WIDE_RE.test(ch) ? 2 : 1;
}

/** CJK 全角按 2 格计算 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** 按显示宽度截断长名称，超出部分补 … */
export function truncate(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 11px 字号下各字形的推进宽度（无头 Chrome 像素扫描实测，整串误差 <1px） */
function glyphPx(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x2e80) return 11;
  if (ch === ' ') return 2.8;
  if (ch === ',' || ch === '.') return 3.1;
  if (ch === '/') return 3.4;
  if (ch === 'w') return 7.9;
  if (ch === '…') return 8.5;
  return 6.1;
}

export function textPx(s: string): number {
  let px = 0;
  for (const ch of s) px += glyphPx(ch);
  return px;
}

/** 额度列右锚点：名称列满截断 62 + 列间距 20 + 额度列最宽 62.6，到期列(≤86.1)左缘仍余 20 */
const QUOTA_RIGHT = 145.6;
const COL_GAP_PX = 20;
/** 1 个显示格（半个汉字）在 11px 字号下的推进宽度 */
const CELL_PX = 5.5;
/** 省略号实测 8.5px 而 displayWidth 只记 1 格（5.5px），故预留 3px 余量 */
const ELLIPSIS_EXTRA_PX = 3;
const NAME_CELLS_MAX = 11;
const NAME_CELLS_MIN = 6;

/** 名称列可用格数：额度串越宽名称列越短，两列字面间距恒为 20px */
export function nameCells(quotaText: string): number {
  const room = QUOTA_RIGHT - COL_GAP_PX - textPx(quotaText) - ELLIPSIS_EXTRA_PX;
  return Math.min(NAME_CELLS_MAX, Math.max(NAME_CELLS_MIN, Math.floor(room / CELL_PX)));
}

export interface PanelData {
  remain: number;
  total: number;
  pct: number;
  unlimited: boolean;
  packs: Array<{ name: string; remain: number; limit: number; pct: number; unlimited: boolean; expiry: string }>;
  checkin: string;
  updatedAt: string;
}

/** 到期列到分钟；不限量包占比按 100 显示 */
export function buildPanelData(summary: CreditsSummary, checkin: string, updatedAt: string): PanelData {
  return {
    remain: summary.remain,
    total: summary.total,
    pct: summary.unlimited ? 100 : pctOf(summary.remain, summary.total),
    unlimited: summary.unlimited,
    packs: summary.packs.map((p) => ({
      name: p.name,
      remain: p.remain,
      limit: p.limit,
      pct: p.unlimited ? 100 : pctOf(p.remain, p.limit),
      unlimited: p.unlimited,
      expiry: formatDateTime(p.expireTime)
    })),
    checkin,
    updatedAt
  };
}

export interface Palette {
  strong: string;
  body: string;
  muted: string;
  track: string;
  divider: string;
  rowLine: string;
  /** 进度条三档：>60% 蓝 / 20~60% 橙 / ≤20% 红 */
  accent: string;
  accentMid: string;
  accentLow: string;
  /** 百分比胶囊三档，与进度条同档同色系（更深，白字才压得住） */
  pill: string;
  pillMid: string;
  pillLow: string;
}

/** SVG 内不能引用 VSCode 的 CSS 变量，按主题手选色；进度条与胶囊按余量分三档（>60% 蓝 / 20~60% 橙 / ≤20% 红） */
export function paletteFor(theme: 'light' | 'dark'): Palette {
  if (theme === 'light') {
    return {
      strong: '#1f2328',
      body: '#24292f',
      muted: '#57606a',
      track: '#d0d7de',
      divider: 'rgba(31,35,40,0.28)',
      rowLine: 'rgba(31,35,40,0.16)',
      accent: '#0969da',
      accentMid: '#fb8500',
      accentLow: '#cf222e',
      pill: '#0550ae',
      pillMid: '#bc4c00',
      pillLow: '#a5111b'
    };
  }
  return {
    strong: '#ffffff',
    body: '#e6e6e6',
    muted: '#9a9ea6',
    track: '#3f3f46',
    divider: 'rgba(128,128,128,0.25)',
    rowLine: 'rgba(128,128,128,0.18)',
    accent: '#2196f3',
    accentMid: '#ff9800',
    accentLow: '#f48771',
    pill: '#1976d2',
    pillMid: '#e65100',
    pillLow: '#d9534f'
  };
}

/* ============================ 标题栏图标 ============================ */
const iconCache = new Map<string, string>();
function cachedIcon(key: string, build: () => string): string {
  let uri = iconCache.get(key);
  if (!uri) {
    uri = build();
    iconCache.set(key, uri);
  }
  return uri;
}

/** 刷新（双向弧 sync） */
export function refreshIconUri(color: string): string {
  return cachedIcon('refresh:' + color, () => svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.8a5.2 5.2 0 0 1 8.9-2.4M12.8 9.2a5.2 5.2 0 0 1-8.9 2.4"/><path d="M12.9 1.6v3.2H9.7"/><path d="M3.1 14.4v-3.2h3.2"/></g></svg>`));
}

/** 齿轮（外齿 + 镂空圆环） */
export function gearIconUri(color: string): string {
  return cachedIcon('gear:' + color, () => svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="${color}">${[0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => `<rect x="7" y="0.9" width="2" height="2.7" rx="0.7" transform="rotate(${a} 8 8)"/>`)
    .join('')}</g><circle cx="8" cy="8" r="3.4" fill="none" stroke="${color}" stroke-width="2.6"/></svg>`));
}

/** 用量明细（四根等长横线，对齐 traecn） */
export function usageIconUri(color: string): string {
  return cachedIcon('usage:' + color, () => svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><g fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"><path d="M2.8 3.2h10.4"/><path d="M2.8 6.4h10.4"/><path d="M2.8 9.6h10.4"/><path d="M2.8 12.8h10.4"/></g></svg>`));
}

/** 用量明细跳转目标：CodeBuddy 网页端用量页 */
export function usageTargetHref(): string {
  return 'https://www.workbuddy.cn/profile/plans-usage';
}

/* ====================== 宿主页脚底距补偿 ====================== */
/**
 * 行内图下方宿主额外补的空间两家不同：VS Code / CodeBuddy 系补 ~7.9 单位（契约取 9），
 * Trae 系 CSS 覆盖后补 ~3.4（契约取 4）。未识别宿主回落 VS Code。
 */
export function footerHostPad(appName: string | undefined): number {
  return /trae/i.test(appName ?? '') ? 4 : 9;
}

/* ====================== 纵向墨迹栅格 ====================== */
const W = 251.7;
/** 相邻元素「墨迹」之间留 GAP 行空白；像素行闭区间，故 STEP = GAP + 1 */
const GAP = 10;
const STEP = GAP + 1;
/** 表头二字墨迹底 → 表头分隔线，比其他间距收紧一半 */
const HEAD_LINE_GAP = 5 + 1;
const BAR_ROWS = 5;
const LINE_ROWS = 1;
const NUM_ASC = 22; // 30px 数字：基线上 22 行有墨迹
const NUM_DESC = 3; // 700 字重下逗号多占 1 行
const TXT_ASC = 9; // 10~11px 中英混排：基线上 9 行，下 1 行
const TXT_DESC = 1;
/** 标题墨迹底到 SVG 顶有 ~10.7px 固定余量，再垫 4 行 → 标题到数字实测间距 15 */
const NUM_TOP_PAD = 4;

export interface TooltipLayout {
  numBase: number;
  barTop: number;
  headBase: number;
  headLineTop: number;
  rowBase: number;
  rowPitch: number;
  footBase: number;
  H: number;
}

export function tooltipLayout(detailRows: number, appName: string | undefined): TooltipLayout {
  const rows = Math.max(0, detailRows);
  const numBase = NUM_TOP_PAD + NUM_ASC;
  const numBot = numBase + NUM_DESC;
  const barTop = numBot + STEP;
  const headBase = barTop + BAR_ROWS + STEP + TXT_ASC;
  const headLineTop = headBase + TXT_DESC + HEAD_LINE_GAP;
  const rowBase = headLineTop + LINE_ROWS + STEP + TXT_ASC;
  const rowPitch = TXT_DESC + STEP + STEP + TXT_ASC;
  const lastRowBot = rowBase + Math.max(rows - 1, 0) * rowPitch + TXT_DESC;
  const footBase = lastRowBot + STEP * 2 + TXT_ASC;
  const H = footBase + TXT_DESC + STEP - footerHostPad(appName);
  return { numBase, barTop, headBase, headLineTop, rowBase, rowPitch, footBase, H };
}

/* ============================ SVG 主体 ============================ */
export function buildTooltipSvg(data: PanelData, pal: Palette, detailRows: number, appName: string | undefined): string {
  const shown = data.packs.slice(0, detailRows);
  const RIGHT = W;
  const X_QUOTA = QUOTA_RIGHT;
  // 高度按实际显示行数算，而非 detailRows：积分包少于配置行数时，页脚要紧跟实际末行，否则底部留空
  const L = tooltipLayout(shown.length, appName);
  const parts: string[] = [];
  // 主数值 + 分母（数字更大更粗，分母小字贴基线）；不限量显示 ∞ / 不限量
  const big = data.unlimited ? '∞' : escHtml(fmtCredits(data.remain));
  const sub = data.unlimited ? ' 不限量' : ` / ${escHtml(fmtCredits(data.total))}`;
  parts.push(`<text x="0" y="${L.numBase}" fill="${pal.strong}" font-size="30" font-weight="700">${big}<tspan fill="${pal.muted}" font-size="13" font-weight="400">${sub}</tspan></text>`);
  // 百分比胶囊（右上，实心底白字，与数字墨迹带垂直居中）；进度条与胶囊按余量分三档
  // >60% 蓝 / 20~60% 橙 / ≤20% 红；不限量按满格蓝处理
  const accent = data.pct <= 20 ? pal.accentLow : data.pct <= 60 ? pal.accentMid : pal.accent;
  const pillFill = data.pct <= 20 ? pal.pillLow : data.pct <= 60 ? pal.pillMid : pal.pill;
  const pillW = 44;
  const pillH = 22;
  const pillX = RIGHT - pillW;
  const pillY = NUM_TOP_PAD + (NUM_ASC + NUM_DESC - pillH) / 2;
  parts.push(`<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="11" fill="${pillFill}"/>`);
  parts.push(`<text x="${pillX + pillW / 2}" y="${pillY + pillH / 2 + 1}" fill="#ffffff" font-size="11" font-weight="700" text-anchor="middle" dominant-baseline="middle">${data.unlimited ? '∞' : data.pct + '%'}</text>`);
  // 进度条（0% 时保底圆角可见；不限量时满）
  const barPct = data.unlimited ? 100 : data.pct;
  parts.push(`<rect x="0" y="${L.barTop}" width="${W}" height="${BAR_ROWS}" rx="2.5" fill="${pal.track}"/>`);
  parts.push(`<rect x="0" y="${L.barTop}" width="${Math.max(BAR_ROWS, (W * barPct) / 100).toFixed(1)}" height="${BAR_ROWS}" rx="2.5" fill="${accent}"/>`);
  // 表头（下方一条分隔线）
  parts.push(`<text x="0" y="${L.headBase}" fill="${pal.muted}" font-size="10">明细</text>`);
  parts.push(`<text x="${X_QUOTA}" y="${L.headBase}" fill="${pal.muted}" font-size="10" text-anchor="end">额度</text>`);
  parts.push(`<text x="${RIGHT}" y="${L.headBase}" fill="${pal.muted}" font-size="10" text-anchor="end">到期</text>`);
  parts.push(`<line x1="0" y1="${L.headLineTop + LINE_ROWS / 2}" x2="${W}" y2="${L.headLineTop + LINE_ROWS / 2}" stroke="${pal.divider}" stroke-width="1"/>`);
  // 明细行：名称列格数按本次展示的最宽额度串统一算，逐行各算会让同列截断长短不齐
  const widestQuota = shown
    .map((p) => `${p.unlimited ? '∞' : fmtCredits(p.remain)} / ${p.unlimited ? '不限量' : fmtCredits(p.limit)}`)
    .reduce((a, b) => (textPx(b) > textPx(a) ? b : a), '');
  const nameWidth = nameCells(widestQuota);
  let y = L.rowBase;
  for (const p of shown) {
    const remainText = p.unlimited ? '∞' : escHtml(fmtCredits(p.remain));
    const limitText = p.unlimited ? '不限量' : escHtml(fmtCredits(p.limit));
    parts.push(`<text x="0" y="${y}" fill="${pal.body}" font-size="11">${escHtml(truncate(p.name, nameWidth))}</text>`);
    parts.push(`<text x="${X_QUOTA}" y="${y}" font-size="11" text-anchor="end"><tspan fill="${pal.strong}" font-weight="600">${remainText}</tspan><tspan fill="${pal.muted}" font-weight="400"> / ${limitText}</tspan></text>`);
    parts.push(`<text x="${RIGHT}" y="${y}" fill="${pal.muted}" font-size="9.5" text-anchor="end">${escHtml(p.expiry)}</text>`);
    const lineTop = y + TXT_DESC + STEP;
    parts.push(`<line x1="0" y1="${lineTop + LINE_ROWS / 2}" x2="${W}" y2="${lineTop + LINE_ROWS / 2}" stroke="${pal.rowLine}" stroke-width="1"/>`);
    y += L.rowPitch;
  }
  // 页脚：签到状态（只说今天签没签，不带日期）+ 本次刷新时间
  const checkinText = data.checkin === 'claimed' ? '今日已签到'
    : data.checkin === 'unclaimed' ? '今日未签到'
      : data.checkin === 'disabled' ? '签到活动未开启'
        : '签到未查询';
  const dotColor = data.checkin === 'claimed' ? '#4caf50' : data.checkin === 'unclaimed' ? '#d7a33a' : pal.muted;
  parts.push(`<circle cx="3.5" cy="${L.footBase - (TXT_ASC - TXT_DESC) / 2}" r="3.5" fill="${dotColor}"/>`);
  parts.push(`<text x="12" y="${L.footBase}" fill="${pal.body}" font-size="11">${escHtml(checkinText)}</text>`);
  parts.push(`<text x="${RIGHT}" y="${L.footBase}" fill="${pal.muted}" font-size="10" text-anchor="end">更新 ${escHtml(data.updatedAt)}</text>`);
  // SVG 在 tooltip 里落在 ~38.7px 处，整体下移 0.3 让元素压在整数像素行上，
  // 否则抗锯齿会把 1px 分隔线糊成两行（实测间距在 10/11 之间跳）。
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${L.H}" viewBox="0 0 ${W} ${L.H}" font-family="Segoe UI, Microsoft YaHei, sans-serif"><g transform="translate(0,0.3)">${parts.join('')}</g></svg>`;
}

/* ============================ Markdown 包装 ============================ */
export const DEFAULT_DETAIL_ROWS = 3;
export const MIN_DETAIL_ROWS = 1;
export const MAX_DETAIL_ROWS = 6;

export function clampDetailRows(n: number): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_DETAIL_ROWS;
  return Math.min(MAX_DETAIL_ROWS, Math.max(MIN_DETAIL_ROWS, v));
}

/**
 * hover 浮窗 Markdown：标题行（左标题 + 右浮动可点图标）+ 单张透明背景 SVG 数据体。
 * 图标必须放 Markdown 层才可点（图片内部元素不可点）；float:right 按 DOM 顺序从右往左排，
 * 故 DOM 顺序 齿轮→刷新 视觉上是 刷新·齿轮，齿轮贴内容右缘。
 */
export function buildTooltipMarkdown(data: PanelData, opts: { theme?: 'light' | 'dark'; iconColor?: string; detailRows?: number; appName?: string } = {}): string {
  const pal = paletteFor(opts.theme ?? 'dark');
  const iconColor = opts.iconColor ?? pal.muted;
  const rows = clampDetailRows(opts.detailRows ?? DEFAULT_DETAIL_ROWS);
  const gear = `<a href="command:workbench.action.openSettings?%5B%22codebuddyquota%22%5D" title="设置"><img src="${gearIconUri(iconColor)}" align="right" width="14" hspace="6" alt="设置"></a>`;
  const refresh = `<a href="command:codebuddyquota.refresh" title="刷新"><img src="${refreshIconUri(iconColor)}" align="right" width="14" hspace="18" alt="刷新"></a>`;
  const usage = `<a href="${usageTargetHref()}" title="用量明细"><img src="${usageIconUri(iconColor)}" align="right" width="14" hspace="6" alt="用量明细"></a>`;
  const body = svgDataUri(buildTooltipSvg(data, pal, rows, opts.appName));
  return `### CodeBuddy 积分面板 ${gear}${refresh}${usage}\n\n![积分数据](${body})`;
}
