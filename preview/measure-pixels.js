const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath, chromeArgs } = require('./chrome.js');
const { readPng } = require('./png.js');
const { buildPanelData, buildTooltipSvg, paletteFor } = require('../out/tooltip.js');

/**
 * 纵向门禁：截图上逐行扫描**真实墨迹**带，断言相邻墨迹之间的空白间距。
 * 这是胶囊版「纵向栅格」的唯一回归门——measure-columns.js 只管横向列宽。
 *
 * 外壳 CSS 与标题行照 VSCode 的 `.monaco-hover` 复刻（与 render-panel.js 同一套），
 * 标题行**不放图标**：图标是 14px 图片，会额外产生墨迹带，把带宽一起算进来。
 * `npm run test:layout` 带 `--check` 跑它。
 */

const SUMMARY = {
  remain: 5652,
  total: 7000,
  unlimited: false,
  packs: [
    { name: '基础积分包', remain: 1202, limit: 2000, unlimited: false, expireTime: '2026-12-31 18:38' },
    { name: '签到奖励包', remain: 352, limit: 500, unlimited: false, expireTime: '2027-01-15 08:00' },
    { name: '新用户礼包', remain: 2000, limit: 2000, unlimited: false, expireTime: '2027-01-20 09:15' }
  ]
};

/** 每行金额串里有没有逗号——有逗号才有下伸，这才决定「行→分隔线」是 10 还是 11 */
const ROW_HAS_DESCENDER = [true, false, true];
const ROWS = ROW_HAS_DESCENDER.length;

function bodySvg() {
  const data = buildPanelData(SUMMARY, 'unclaimed', '14:39');
  return buildTooltipSvg(data, paletteFor('dark'), ROWS, undefined);
}

function page(svg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#252526}
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.workbench-hover{position:relative;font-size:13px;line-height:19px;background:#252526;border:1px solid #454545;color:#cccccc;box-sizing:border-box;display:inline-block}
.monaco-hover{box-sizing:border-box;line-height:1.5em}
.monaco-hover .hover-contents{padding:4px 8px}
.monaco-hover p,.monaco-hover h3{margin:8px 0}
.monaco-hover h3{line-height:1.1;font-size:15.21px;font-weight:700}
.monaco-hover p:last-child{margin-bottom:0}
</style></head><body><div class="workbench-hover monaco-hover"><div class="markdown-hover"><div class="hover-contents">
<h3>CodeBuddy 积分面板</h3>
<p>${svg.replace('<svg ', '<svg id="body" ')}</p>
</div></div></div></body></html>`;
}

const BG = [0x25, 0x25, 0x26];

/**
 * 期望的墨迹间距（自上而下，与 traecn 的版式同一套）：
 *  14 外框顶→标题（VSCode 的边框+padding+h3 margin）
 *  13 标题→大数字：本家标题 `CodeBuddy 积分面板` 里的 `y` 有下伸，把标题墨迹底压低 2 行，
 *     所以比 traecn 的 `TraeCN 积分余额`（无下伸，15）少 2。改标题文案要同步改这个数。
 *  10 大数字→进度条、10 进度条→表头、5 表头→表头分隔线（HEAD_LINE_GAP 收紧一半）
 *  每行两段：分隔线→行 10；行→分隔线 10，但该行无逗号等下伸字符时是 11
 *  末行分隔线→页脚 10、页脚→浮窗下边缘 10
 */
const EXPECTED = [14, 13, 10, 10, 5];
for (let i = 0; i < ROWS; i++) {
  EXPECTED.push(10, ROW_HAS_DESCENDER[i] ? 10 : 11);
}
EXPECTED.push(10, 10);

const CHECK = process.argv.includes('--check');
let failures = 0;

const html = path.join(__dirname, '_pixels.html');
const png = path.join(__dirname, '_pixels.png');
fs.writeFileSync(html, page(bodySvg()), 'utf8');
execFileSync(chromePath(),
  ['--headless=new', '--disable-gpu', ...chromeArgs(), '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=320,420', `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')],
  { encoding: 'utf8', timeout: 90000 });
const { w, h, bpp, px } = readPng(png);
fs.unlinkSync(html); fs.unlinkSync(png);

const bands = [];
let cur = null;
for (let y = 0; y < h; y++) {
  let hit = 0;
  // 跳过 1px 边框列，否则边框会让每一行都算「有内容」
  for (let x = 3; x < 266; x++) {
    const i = y * w * bpp + x * bpp;
    if (Math.abs(px[i] - BG[0]) + Math.abs(px[i + 1] - BG[1]) + Math.abs(px[i + 2] - BG[2]) > 12) { hit++; if (hit > 1) break; }
  }
  if (hit > 1) {
    if (!cur) cur = { top: y, bottom: y };
    else cur.bottom = y;
  } else if (cur) { bands.push(cur); cur = null; }
}
if (cur) bands.push(cur);

const gaps = [];
let prev = null;
bands.forEach((b) => {
  if (prev) gaps.push(b.top - prev.bottom - 1);
  prev = b;
});

console.log(`截图 ${w}x${h}，检出 ${bands.length} 个墨迹带`);
bands.forEach((b, i) => {
  console.log((i === 0 ? '     -' : String(gaps[i - 1]).padStart(6)) + ' | y ' + b.top + ' ~ ' + b.bottom + '  高 ' + (b.bottom - b.top + 1));
});
const bad = gaps.map((g, i) => (EXPECTED[i] === undefined || g === EXPECTED[i] ? null : `第${i + 1}处 期望 ${EXPECTED[i]} 实测 ${g}`)).filter(Boolean);
if (gaps.length !== EXPECTED.length) {
  bad.push(`间距段数 期望 ${EXPECTED.length} 实测 ${gaps.length}`);
}
if (bad.length) {
  failures++;
  console.log('FAIL: ' + bad.join('；'));
} else {
  console.log(`OK: ${EXPECTED.length} 处墨迹间距全部符合期望`);
}

process.exit(CHECK && failures ? 1 : 0);
