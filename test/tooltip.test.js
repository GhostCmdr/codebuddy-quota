const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../out/tooltip.js');

const SUMMARY = {
  remain: 5802,
  total: 7100,
  unlimited: false,
  packs: [
    { name: '基础积分包', remain: 1202, limit: 2000, unlimited: false, expireTime: '2026-12-31 18:38:23' },
    { name: '签到奖励', remain: 150, limit: 150, unlimited: false, expireTime: '2027-01-15T08:00:00' }
  ]
};

test('displayWidth 全角按 2 格、半角按 1 格', () => {
  assert.strictEqual(t.displayWidth('中文'), 4);
  assert.strictEqual(t.displayWidth('ab'), 2);
  assert.strictEqual(t.displayWidth('中a'), 3);
});

test('truncate 放得下原样返回，放不下截断补省略号', () => {
  assert.strictEqual(t.truncate('基础积分包', 10), '基础积分包');
  assert.strictEqual(t.truncate('限时活动赠送积分包超长名称', 8), '限时活…');
  assert.strictEqual(t.truncate('中文名', 1), '…');
});

test('textPx 按 11px 实测字形累加', () => {
  assert.strictEqual(t.textPx('中中'), 22);
  assert.strictEqual(t.textPx('w'), 7.9);
  assert.strictEqual(t.textPx('0'), 6.1);
  assert.strictEqual(t.textPx(''), 0);
});

test('nameCells 额度串越宽名称列越短，且钳在 6~11 格', () => {
  const narrow = t.nameCells('760 / 2,000');
  const wide = t.nameCells('98,765,432 / 98,765,432');
  assert.ok(wide <= narrow, `${wide} 应不超过 ${narrow}`);
  assert.ok(t.nameCells('∞ / 不限量') >= 6);
  assert.ok(t.nameCells('0 / 0') <= 11);
});

test('tooltipLayout 高度随实际行数增长', () => {
  const zero = t.tooltipLayout(0, undefined);
  const one = t.tooltipLayout(1, undefined);
  const three = t.tooltipLayout(3, undefined);
  assert.strictEqual(three.H - one.H, 64); // 每多一行 rowPitch=32，两行差 64
  assert.strictEqual(one.H, zero.H);
  assert.ok(three.footBase > three.rowBase);
});

test('footerHostPad：Trae 系扣 4，其余扣 9', () => {
  assert.strictEqual(t.footerHostPad('Trae CN'), 4);
  assert.strictEqual(t.footerHostPad('TRAE SOLO CN'), 4);
  assert.strictEqual(t.footerHostPad('Visual Studio Code'), 9);
  assert.strictEqual(t.footerHostPad(undefined), 9);
});

test('tooltipLayout：Trae 宿主的 SVG 比 VS Code 宿主高 5（扣 4 对扣 9）', () => {
  const vs = t.tooltipLayout(3, 'Visual Studio Code').H;
  const trae = t.tooltipLayout(3, 'Trae CN').H;
  assert.strictEqual(trae - vs, 5);
});

test('clampDetailRows 非法值回落 3、合法值钳到 1~6', () => {
  assert.strictEqual(t.clampDetailRows(NaN), 3);
  assert.strictEqual(t.clampDetailRows(undefined), 3);
  assert.strictEqual(t.clampDetailRows(0), 1);
  assert.strictEqual(t.clampDetailRows(99), 6);
  assert.strictEqual(t.clampDetailRows(4), 4);
});

test('paletteFor 明暗两套、字段齐全', () => {
  const light = t.paletteFor('light');
  const dark = t.paletteFor('dark');
  assert.notStrictEqual(light.strong, dark.strong);
  for (const key of ['strong', 'body', 'muted', 'track', 'divider', 'rowLine', 'accent', 'accentMid', 'accentLow', 'pill', 'pillMid', 'pillLow']) {
    assert.ok(typeof light[key] === 'string' && light[key].length > 0, key);
    assert.ok(typeof dark[key] === 'string' && dark[key].length > 0, key);
  }
});

test('进度条与胶囊按余量三档变色：>60 蓝 / 20~60 橙 / ≤20 红', () => {
  const pal = t.paletteFor('dark');
  const svgFor = (remain, total) => {
    const d = t.buildPanelData({ remain, total, unlimited: false, packs: [] }, 'unknown', '14:39');
    return t.buildTooltipSvg(d, pal, 0, undefined);
  };
  const high = svgFor(800, 1000); // 80%
  assert.ok(high.includes(pal.accent) && high.includes(pal.pill), '80% 应用蓝');
  assert.ok(!high.includes(pal.accentMid) && !high.includes(pal.accentLow));

  const mid = svgFor(500, 1000); // 50%
  assert.ok(mid.includes(pal.accentMid) && mid.includes(pal.pillMid), '50% 应用橙');
  assert.ok(!mid.includes(pal.accent) && !mid.includes(pal.accentLow));

  const low = svgFor(100, 1000); // 10%
  assert.ok(low.includes(pal.accentLow) && low.includes(pal.pillLow), '10% 应用红');
  assert.ok(!low.includes(pal.accent) && !low.includes(pal.accentMid));
});

test('三档的边界：60 为橙、61 为蓝、20 为红、21 为橙', () => {
  const pal = t.paletteFor('dark');
  const barColor = (remain, total) => {
    const d = t.buildPanelData({ remain, total, unlimited: false, packs: [] }, 'unknown', '14:39');
    const svg = t.buildTooltipSvg(d, pal, 0, undefined);
    return [pal.accent, pal.accentMid, pal.accentLow].find((c) => svg.includes(c));
  };
  assert.strictEqual(barColor(600, 1000), pal.accentMid, '60% 应算橙');
  assert.strictEqual(barColor(610, 1000), pal.accent, '61% 应算蓝');
  assert.strictEqual(barColor(200, 1000), pal.accentLow, '20% 应算红');
  assert.strictEqual(barColor(210, 1000), pal.accentMid, '21% 应算橙');
});

test('buildPanelData 到期列到分钟、占比封顶', () => {
  const d = t.buildPanelData(SUMMARY, 'claimed', '14:39');
  assert.strictEqual(d.packs[0].expiry, '2026-12-31 18:38');
  assert.strictEqual(d.packs[1].expiry, '2027-01-15 08:00');
  assert.strictEqual(d.checkin, 'claimed');
  assert.strictEqual(d.pct, Math.round((5802 / 7100) * 100));
});

test('buildPanelData 整体不限量时 pct 记 100、明细行显示 ∞', () => {
  const d = t.buildPanelData({ remain: 0, total: 0, unlimited: true, packs: [] }, 'unknown', '14:39');
  assert.strictEqual(d.pct, 100);
  const svg = t.buildTooltipSvg(d, t.paletteFor('dark'), 3, undefined);
  assert.ok(svg.includes('∞'));
});

test('buildTooltipSvg 含表头、页脚签到与更新时间', () => {
  const d = t.buildPanelData(SUMMARY, 'unclaimed', '14:39');
  const svg = t.buildTooltipSvg(d, t.paletteFor('dark'), 3, undefined);
  assert.ok(svg.includes('明细'));
  assert.ok(svg.includes('额度'));
  assert.ok(svg.includes('到期'));
  assert.ok(svg.includes('今日未签到'));
  assert.ok(svg.includes('更新 14:39'));
  assert.ok(svg.includes('translate(0,0.3)'));
});

test('buildTooltipMarkdown 标题行 + 内联 SVG 数据体', () => {
  const d = t.buildPanelData(SUMMARY, 'claimed', '14:39');
  const md = t.buildTooltipMarkdown(d, { theme: 'dark', detailRows: 3, appName: 'Visual Studio Code' });
  assert.ok(md.startsWith('### CodeBuddy 积分面板'));
  assert.ok(md.includes('command:codebuddyquota.refresh'));
  assert.ok(md.includes('workbuddy.cn/profile/plans-usage'));
  assert.ok(md.includes('![积分数据]('));
});
