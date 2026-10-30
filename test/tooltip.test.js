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

test('textPx 按 11px 实测字形累加', () => {
  assert.strictEqual(t.textPx('中中'), 22);
  assert.strictEqual(t.textPx('w'), 7.95);
  assert.strictEqual(t.textPx('0'), 5.93);
  assert.strictEqual(t.textPx('W'), 10.27);
  assert.strictEqual(t.textPx('…'), 8.06);
  assert.strictEqual(t.textPx(''), 0);
});

test('truncatePx 放得下原样、放不下先扣省略号再逐字截断', () => {
  assert.strictEqual(t.truncatePx('基础积分包', 60), '基础积分包');
  const cut = t.truncatePx('限时活动赠送积分包超长名称', 60);
  assert.ok(cut.endsWith('…'), cut);
  assert.ok(t.textPx(cut) <= 60, `${cut} ${t.textPx(cut)}px`);
  assert.strictEqual(t.truncatePx('一二三四五', 50), '一二三…');
});

test('truncatePx 补省略号前去掉尾部空格', () => {
  assert.strictEqual(t.truncatePx('Alpha Beta', 39.87), 'Alpha…');
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

test('账号徽标只在标题行渲染，不进 SVG 数据体', () => {
  const pal = t.paletteFor('dark');
  const withName = t.buildPanelData(SUMMARY, 'claimed', '14:39', 'Ghost');
  const without = t.buildPanelData(SUMMARY, 'claimed', '14:39');
  const a = t.buildTooltipSvg(withName, pal, 3, undefined);
  const b = t.buildTooltipSvg(without, pal, 3, undefined);
  assert.strictEqual(a, b, '数据体与账号无关，行高不变');

  const md = t.buildTooltipMarkdown(withName, { theme: 'dark', detailRows: 3, appName: 'Visual Studio Code' });
  assert.ok(/alt="当前账号 Ghost"/.test(md), '标题行带账号徽标');
  assert.strictEqual((md.match(/align="right"/g) || []).length, 3, '只有三枚图标右浮动，徽标是行内');
  assert.ok(md.indexOf('alt="当前账号') < md.indexOf('alt="设置"'), '账号徽标在标题文字之后、图标之前（行内）');

  const mdNone = t.buildTooltipMarkdown(without, { theme: 'dark', detailRows: 3 });
  assert.ok(!/alt="当前账号/.test(mdNone), '没昵称就不渲染徽标');
});

test('账号徽标：放得下原样，放不下按宽度补省略号', () => {
  assert.strictEqual(t.clipAccountName('Ghost'), 'Ghost');
  assert.strictEqual(t.clipAccountName('ghosty'), 'ghosty', '放得下就不加省略号');
  const b = t.accountBadge('Ghost', '#9a9ea6');
  assert.ok(b.width <= 60, `徽标宽 ${b.width}，超了会把右上角图标挤到第二行`);
  assert.ok(b.uri.startsWith('data:image/svg+xml;base64,'), '徽标是内联 SVG 图');
});

test('账号名超宽补省略号，代理对不拆', () => {
  assert.strictEqual(t.clipAccountName('GhostCmdr'), 'GhostC…');
  assert.strictEqual(t.clipAccountName('😀😀😀😀😀😀').endsWith('…'), true);
  assert.ok(!t.clipAccountName('😀😀😀😀😀😀').includes('�'), '不留半个代理对');
});

test('中文昵称按宽度截，不溢出预算', () => {
  assert.strictEqual(t.clipAccountName('积分面板测试号'), '积分面…');
  assert.strictEqual(t.clipAccountName('测试测试测试测试'), '测试测…');
});

test('账号名截断后不留尾部空格，省略号紧跟名字', () => {
  assert.strictEqual(t.clipAccountName('AA BB CC DD EE FF'), 'AA BB…');
  assert.strictEqual(t.clipAccountName('积分 包 名称 很长 很长'), '积分 包…');
});

test('buildPanelData 到期列到分钟、占比四舍五入', () => {
  const d = t.buildPanelData(SUMMARY, 'claimed', '14:39');
  assert.strictEqual(d.packs[0].expiry, '2026-12-31 18:38');
  assert.strictEqual(d.packs[1].expiry, '2027-01-15 08:00');
  assert.strictEqual(d.checkin, 'claimed');
  assert.strictEqual(d.pct, Math.round((5802 / 7100) * 100));
});

test('整体不限量：主额度与明细行显示「不限量 / ∞」，胶囊 100%', () => {
  const d = t.buildPanelData({ remain: 0, total: 0, unlimited: true, packs: [{ name: '不限量包', remain: 0, limit: 0, unlimited: true }] }, 'unknown', '14:39');
  assert.strictEqual(d.pct, 100);
  const svg = t.buildTooltipSvg(d, t.paletteFor('dark'), 3, undefined);
  assert.ok(svg.includes('>不限量<tspan'), '主数字是文本「不限量」');
  assert.ok(svg.includes(' / ∞'), '分母位是 ∞');
  assert.ok(svg.includes('100%'), '胶囊显示 100%');
  assert.ok(svg.includes('>不限量</text>'), '明细行 remain 显示「不限量」');
  assert.ok(svg.includes('>∞</text>'), '明细行 limit 显示 ∞');
  assert.ok(!svg.includes('∞ / ∞'));
});

test('明细行排序：不限量始终置顶；开置顶时订阅套餐更靠前', () => {
  const summary = {
    remain: 3,
    total: 3,
    unlimited: false,
    packs: [
      { name: '赠送A', remain: 1, limit: 1, unlimited: false, plan: false, expireTime: '2026-11-01' },
      { name: '赠送B', remain: 1, limit: 1, unlimited: false, plan: false, expireTime: '2026-10-20' },
      { name: '套餐', remain: 1, limit: 1, unlimited: false, plan: true, expireTime: '2026-12-01' },
      { name: '不限量', remain: 0, limit: 0, unlimited: true, plan: false }
    ]
  };
  const off = t.buildPanelData(summary, 'claimed', '14:39', '', false);
  assert.deepStrictEqual(off.packs.map((p) => p.name), ['不限量', '赠送B', '赠送A', '套餐']);
  const on = t.buildPanelData(summary, 'claimed', '14:39', '', true);
  assert.deepStrictEqual(on.packs.map((p) => p.name), ['套餐', '不限量', '赠送B', '赠送A']);
});

test('关闭置顶且没有不限量包时，保持到期升序', () => {
  const summary = {
    remain: 2,
    total: 2,
    unlimited: false,
    packs: [
      { name: 'B', remain: 1, limit: 1, unlimited: false, plan: false, expireTime: '2026-12-01' },
      { name: 'A', remain: 1, limit: 1, unlimited: false, plan: false, expireTime: '2026-10-01' }
    ]
  };
  const d = t.buildPanelData(summary, 'claimed', '14:39', '', false);
  assert.deepStrictEqual(d.packs.map((p) => p.name), ['A', 'B']);
});

test('空包默认不显示；开启套餐包置顶时套餐包豁免、分母不变', () => {
  const summary = {
    remain: 100,
    total: 1700,
    unlimited: false,
    packs: [
      { name: '套餐', remain: 0, limit: 500, unlimited: false, plan: true, expireTime: '2026-10-31' },
      { name: '赠送', remain: 0, limit: 1000, unlimited: false, plan: false, expireTime: '2026-11-30' },
      { name: '加油', remain: 100, limit: 200, unlimited: false, plan: false, expireTime: '2026-12-31' }
    ]
  };
  const off = t.buildPanelData(summary, 'claimed', '14:39', '', false);
  assert.deepStrictEqual(off.packs.map((p) => p.name), ['加油']);
  assert.strictEqual(off.pct, 6);
  const on = t.buildPanelData(summary, 'claimed', '14:39', '', true);
  assert.deepStrictEqual(on.packs.map((p) => p.name), ['套餐', '加油']);
  assert.strictEqual(on.pct, off.pct, '豁免只影响显示，分母与占比不变');
  assert.strictEqual(on.total, 1700);
});

test('套餐行名称后带「套餐内」标签，名称预算为标签让位', () => {
  const summary = {
    remain: 100,
    total: 600,
    unlimited: false,
    packs: [
      { name: 'CodeBuddy个人体验版', remain: 0, limit: 500, unlimited: false, plan: true, expireTime: '2026-10-31T23:59:59' },
      { name: 'CodeBuddy个人版国内运营裂变包', remain: 100, limit: 100, unlimited: false, plan: false, expireTime: '2026-11-30' }
    ]
  };
  const d = t.buildPanelData(summary, 'claimed', '14:39', '', true);
  const svg = t.buildTooltipSvg(d, t.paletteFor('dark'), 3, undefined);
  assert.ok(svg.includes('>套餐内</text>'), '标签文字');
  assert.ok(svg.includes('width="34" height="14" rx="7"'), '标签 34×14');
  assert.ok(svg.includes('rgba(33,150,243,0.12)'), '标签淡蓝底');
  const lightSvg = t.buildTooltipSvg(d, t.paletteFor('light'), 3, undefined);
  assert.ok(lightSvg.includes('rgba(9,105,218,0.12)'), '浅色主题标签底');
  const planName = svg.match(/<text x="0" y="\d+" fill="#e6e6e6" font-size="11">([^<]*)<\/text>/)[1];
  assert.ok(planName.endsWith('…'), `套餐行名称应截断：${planName}`);
  assert.ok(t.textPx(planName) + 34 + 4 <= 120 - t.textPx('100') - 0.4 - 13, '名称 + 标签不超过名称预算');
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
  const intlMd = t.buildTooltipMarkdown(d, { theme: 'dark', detailRows: 3, intl: true });
  assert.ok(intlMd.includes('workbuddy.ai/profile/plans-usage'), '国际版账号跳国际站用量页');
  assert.ok(!intlMd.includes('workbuddy.cn/profile/plans-usage'));
  assert.ok(md.includes('![积分数据]('));
});
