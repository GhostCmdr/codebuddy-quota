const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromePath, chromeArgs } = require('./chrome.js');

/**
 * 量各字形在明细行 11px / 400 字重下的墨迹宽度（ink），给 tooltip.ts 的 glyphPx 表做**交叉核对**。
 *
 * 注意：这是 getBBox 的墨迹宽，**含悬垂**，不等于推进宽度（advance）。对 `/`、`…` 这类
 * 有悬垂的字形，墨迹会明显大于推进宽（本机实测斜杠墨迹 4.37 而表里推进宽取 3.4），
 * 所以输出的数只能用来发现「大幅偏离」，**不要拿它直接改 glyphPx**。
 * glyphPx 的权威来源是 11px 像素扫描实测（见 tooltip.ts 注释与 tooltip-design-system.md）。
 */

const FAMILY = 'Segoe UI, Microsoft YaHei, sans-serif';
const FS = 11;
const WEIGHT = 400;

// 与 tooltip.ts glyphPx 的表项一一对应；常量值仅用于打印差值
const EXPECTED = { cjk: 11, space: 2.8, comma: 3.1, dot: 3.1, slash: 3.4, w: 7.9, ellipsis: 8.5, default: 6.1 };

const SAMPLES = [
  ['cjk', '中', 10],
  ['digit', '0', 10],
  ['latin', 'a', 10],
  ['comma', ',', 20],
  ['dot', '.', 20],
  ['slash', '/', 20],
  ['ellipsis', '…', 10],
  ['w', 'w', 20]
];

function buildPage() {
  const items = SAMPLES.map(([key, ch, n]) => ({
    id: key, text: ch.repeat(n), n, fs: FS, weight: WEIGHT
  }));
  items.push({ id: 'pairs', text: Array(10).fill('0').join(' '), n: 10, fs: FS, weight: WEIGHT });
  const texts = items
    .map((it) => `<text id="${it.id}" x="0" y="60" font-size="${it.fs}" font-weight="${it.weight}" xml:space="preserve">${it.text}</text>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="120" font-family="${FAMILY}">${texts}</svg>
<script>
const out = {};
for (const el of document.querySelectorAll('svg text')) {
  out[el.id] = +el.getBBox().width.toFixed(4);
}
const div = document.createElement('div');
div.id = 'out';
div.textContent = JSON.stringify(out);
document.body.appendChild(div);
<\/script></body></html>`;
}

function measure() {
  const file = path.join(__dirname, '_glyphs.html');
  fs.writeFileSync(file, buildPage(), 'utf8');
  try {
    const dom = execFileSync(
      chromePath(),
      ['--headless=new', '--disable-gpu', ...chromeArgs(), '--window-size=2200,200', '--virtual-time-budget=3000', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')],
      { encoding: 'utf8', timeout: 90000, maxBuffer: 32 * 1024 * 1024 }
    );
    return JSON.parse(dom.match(/<div id="out">([\s\S]*?)<\/div>/)[1]);
  } finally {
    fs.unlinkSync(file);
  }
}

const raw = measure();
const round = (v) => +v.toFixed(2);
const adv = {};
for (const [key, , n] of SAMPLES) {
  adv[key] = raw[key] / n;
}
adv.space = raw.pairs / 10 - adv.digit;
adv.default = adv.digit;

console.log(`// 11px / 400 墨迹宽（${FAMILY}）——含悬垂，非推进宽度，仅供交叉核对`);
console.log('// 字形      墨迹实测   表里常量   差值');
for (const key of ['cjk', 'space', 'comma', 'dot', 'slash', 'w', 'ellipsis', 'default']) {
  const got = round(adv[key]);
  const want = EXPECTED[key];
  const delta = round(got - want);
  const flag = Math.abs(delta) >= 0.5 ? '  <-- 偏离' : '';
  console.log(`// ${key.padEnd(9)} ${String(got).padStart(8)} ${String(want).padStart(10)} ${String(delta).padStart(7)}${flag}`);
}
