const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');
const c = require('../out/checkin.js');

const EXT = path.resolve(__dirname, '..', 'out', 'extension.js');
const CHECKIN_DATE_KEY = 'codebuddyquota.lastCheckinSuccessDate';

const USAGE = {
  data: { Response: { Data: { Accounts: [
    { PackageName: '基础积分包', CycleCapacityRemainPrecise: '760', CycleCapacitySizePrecise: '2000', CycleEndTime: '2026-12-31 18:38:23' }
  ] } } }
};

/** 真实扩展里 vscode 是宿主注入的模块，这里换成一个可检查的桩 */
let currentVscode = null;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode' && currentVscode) return currentVscode;
  return origLoad.call(this, request, ...rest);
};

function freshToken(offsetSec = 3600, nickname) {
  const payload = { exp: Math.floor(Date.now() / 1000) + offsetSec };
  if (nickname) payload.nickname = nickname;
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

/** 默认响应：积分取得到、签到未领、喵喵旅行在路上（不触发领取与出发） */
function defaultResponder() {
  return async (url) => {
    if (url.includes('checkin-status')) return json({ code: 0, data: { today_checked_in: false } });
    if (url.includes('daily-checkin')) return json({ code: 0, data: { credit: 5 } });
    if (url.includes('buddy/travel/status')) return json({ code: 0, data: { state: 'traveling' } });
    if (url.includes('get-user-resource')) return json(USAGE);
    return json({ code: 0 });
  };
}
function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function drain(rounds = 25) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

async function settle(predicate, rounds = 40) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return predicate();
}

function loadHarness(options = {}) {
  const scopeValues = { global: { ...(options.config || {}) }, workspace: {}, workspaceFolder: {} };
  const secrets = new Map(Object.entries(options.secrets || {}));
  const state = new Map(Object.entries(options.globalState || {}));
  const commands = new Map();
  const statusItems = [];
  const notifications = { info: [], error: [], warning: [] };
  const fetchCalls = [];
  let configHandler = null;
  let themeHandler = null;
  let responder = options.responder || defaultResponder();

  const effective = (key) => {
    for (const scope of ['workspaceFolder', 'workspace', 'global']) {
      if (scopeValues[scope][key] !== undefined) return scopeValues[scope][key];
    }
    return undefined;
  };

  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    MarkdownString: class MarkdownString {
      constructor(value) { this.value = value; }
      appendMarkdown(value) { this.value += value; }
    },
    env: { appName: options.appName || 'Visual Studio Code' },
    window: {
      activeColorTheme: { kind: options.themeKind || 2 },
      createStatusBarItem() {
        const item = {
          text: '', tooltip: '', command: '', visible: false,
          show() { this.visible = true; },
          hide() { this.visible = false; },
          dispose() {}
        };
        statusItems.push(item);
        return item;
      },
      createOutputChannel() { return { appendLine() {}, dispose() {} }; },
      showInformationMessage(m) { notifications.info.push(m); },
      showErrorMessage(m) { notifications.error.push(m); },
      showWarningMessage(m) { notifications.warning.push(m); },
      onDidChangeActiveColorTheme(handler) { themeHandler = handler; return { dispose() {} }; }
    },
    workspace: {
      getConfiguration() {
        return {
          get: (key, dflt) => {
            const v = effective(key);
            return v === undefined ? dflt : v;
          },
          inspect: (key) => ({
            globalValue: scopeValues.global[key],
            workspaceValue: scopeValues.workspace[key],
            workspaceFolderValue: scopeValues.workspaceFolder[key]
          }),
          update: async () => {}
        };
      },
      onDidChangeConfiguration(handler) { configHandler = handler; return { dispose() {} }; }
    },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return { dispose() {} }; }
    }
  };

  currentVscode = vscode;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    return responder(String(url), init);
  };

  delete require.cache[EXT];
  const ext = require(EXT);
  const context = {
    // 当前宿主的登录态目录由这个位置反推；指到不存在的路径 = 该宿主没有可读的会话
    globalStorageUri: { fsPath: path.join(__dirname, '_no_such_host', 'User', 'globalStorage', 'ghostcmdr.codebuddy-quota') },
    secrets: {
      get: async (k) => {
        if (options.secretReadThrows) throw new Error('secret storage unavailable');
        // 只挂住手动 Token 那条读：它才有 5s 超时护栏；缓存 Token 那条没有，挂住会真的卡死
        if (options.secretReadHangs && k === 'manualToken') return new Promise(() => {});
        if (options.secretCacheReadHangs && k === 'cachedAccessToken') return new Promise(() => {});
        return secrets.get(k);
      },
      store: async (k, v) => { secrets.set(k, v); },
      delete: async (k) => { secrets.delete(k); }
    },
    globalState: {
      get: (k) => state.get(k),
      update: async (k, v) => { state.set(k, v); }
    },
    subscriptions: { push() {} }
  };

  return {
    ext, context, statusItems, notifications, fetchCalls, commands, state, secrets,
    setResponder(next) { responder = next; },
    fireThemeChange() { if (themeHandler) themeHandler(); },
    fireConfigChange(changedKeys) {
      const event = {
        affectsConfiguration: (key) => changedKeys.some((c) => c === key || c.startsWith(`${key}.`) || key.startsWith(`${c}.`))
      };
      configHandler(event);
    },
    cleanup() {
      ext.deactivate();
      globalThis.fetch = origFetch;
      currentVscode = null;
      delete require.cache[EXT];
    }
  };
}

/** 从 Markdown 里取出所有内联 SVG 的明文，用于断言胶囊/图形里的文案 */
function svgTexts(markdown) {
  const out = [];
  const re = /data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)/g;
  let m;
  while ((m = re.exec(markdown || ''))) {
    out.push(Buffer.from(m[1], 'base64').toString('utf8'));
  }
  return out;
}

test('activate 注册三个命令并显示状态栏', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    assert.ok(h.commands.has('codebuddyquota.refresh'));
    assert.ok(h.commands.has('codebuddyquota.checkin'));
    assert.ok(h.commands.has('codebuddyquota.clearManualToken'));
    await settle(() => h.statusItems[0] && h.statusItems[0].text.includes('760'));
    assert.strictEqual(h.statusItems[0].visible, true);
  } finally {
    h.cleanup();
  }
});

test('启动刷新展示余量，tooltip 是可信的 MarkdownString', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    assert.strictEqual(h.statusItems[0].text, '$(codebuddy-sparkle) 760 (38%)');
    assert.match(h.statusItems[0].tooltip.value, /积分数据/);
    assert.strictEqual(h.statusItems[0].tooltip.isTrusted, true);
    assert.strictEqual(h.statusItems[0].tooltip.supportHtml, true);
  } finally {
    h.cleanup();
  }
});

test('自动签到成功时静默、并把当天写进 globalState 守卫', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.fetchCalls.some((u) => u.includes('daily-checkin')));
    await drain();
    assert.deepStrictEqual(h.notifications.info, []);
    assert.deepStrictEqual(h.notifications.error, []);
    const key = c.accountKeyOf(h.secrets.get('manualToken'));
    assert.strictEqual(h.state.get(CHECKIN_DATE_KEY)[key], c.todayString());
  } finally {
    h.cleanup();
  }
});

test('守卫说今天已领过时不再发领取请求，浮窗显示已签到', async () => {
  const token = freshToken();
  const h = loadHarness({
    secrets: { manualToken: token },
    globalState: { [CHECKIN_DATE_KEY]: { [c.accountKeyOf(token)]: c.todayString() } }
  });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    await drain();
    assert.ok(!h.fetchCalls.some((u) => u.includes('daily-checkin')), '不应再发签到请求');
    assert.ok(svgTexts(h.statusItems[0].tooltip.value).some((s) => s.includes('已签到')));
  } finally {
    h.cleanup();
  }
});

test('换账号（不同 token）不被上一个账号的守卫挡住', async () => {
  const h = loadHarness({
    secrets: { manualToken: freshToken() },
    globalState: { [CHECKIN_DATE_KEY]: { deadbeef: c.todayString() } }
  });
  try {
    h.ext.activate(h.context);
    await settle(() => h.fetchCalls.some((u) => u.includes('daily-checkin')));
    assert.ok(h.fetchCalls.some((u) => u.includes('daily-checkin')));
  } finally {
    h.cleanup();
  }
});

test('没有可用凭据时状态栏报未找到登录凭据', async () => {
  const h = loadHarness({});
  try {
    h.ext.activate(h.context);
    await settle(() => String(h.statusItems[0].tooltip).includes('未找到登录凭据'));
    assert.strictEqual(h.statusItems[0].text, '$(codebuddy-sparkle) --');
    assert.match(h.statusItems[0].tooltip, /未找到登录凭据/);
    assert.deepStrictEqual(h.fetchCalls, []);
  } finally {
    h.cleanup();
  }
});

test('接口连续 401 时提示登录过期', async () => {
  const h = loadHarness({
    secrets: { manualToken: freshToken() },
    responder: async () => json({ code: 1001 }, 401)
  });
  try {
    h.ext.activate(h.context);
    await settle(() => String(h.statusItems[0].tooltip).includes('登录已过期'));
    assert.strictEqual(h.statusItems[0].text, '$(codebuddy-sparkle) --');
    assert.match(h.statusItems[0].tooltip, /登录已过期/);
  } finally {
    h.cleanup();
  }
});

test('积分接口非 200 时状态栏报读取失败', async () => {
  const h = loadHarness({
    secrets: { manualToken: freshToken() },
    responder: async (url) => (url.includes('get-user-resource')
      ? json({ code: 500 }, 500)
      : json({ code: 0, data: { today_checked_in: false } }))
  });
  try {
    h.ext.activate(h.context);
    await settle(() => String(h.statusItems[0].tooltip).includes('积分读取失败'));
    assert.match(h.statusItems[0].tooltip, /HTTP 500/);
  } finally {
    h.cleanup();
  }
});

test('只拨领取开关不重新取数，改刷新间隔才取数', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    const before = h.fetchCalls.length;
    h.fireConfigChange(['codebuddyquota.autoCheckin']);
    await drain();
    assert.strictEqual(h.fetchCalls.length, before, '拨 autoCheckin 不应产生请求');
    h.fireConfigChange(['codebuddyquota.refreshInterval']);
    await settle(() => h.fetchCalls.length > before);
    assert.ok(h.fetchCalls.length > before);
  } finally {
    h.cleanup();
  }
});

test('只改 detailRows 免网络重绘，浮窗立即重画', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    const before = h.fetchCalls.length;
    h.fireConfigChange(['codebuddyquota.detailRows']);
    await drain();
    assert.strictEqual(h.fetchCalls.length, before, '改 detailRows 不应产生请求');
    assert.match(h.statusItems[0].tooltip.value, /积分数据/);
  } finally {
    h.cleanup();
  }
});

test('手动签到：守卫挡下时提示今日已签到并刷新一次', async () => {
  const token = freshToken();
  const h = loadHarness({
    config: { autoCheckin: false },
    secrets: { manualToken: token },
    globalState: { [CHECKIN_DATE_KEY]: { [c.accountKeyOf(token)]: c.todayString() } }
  });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    await h.commands.get('codebuddyquota.checkin')();
    assert.ok(h.notifications.info.some((m) => m.includes('今日已签到')));
    assert.ok(!h.fetchCalls.some((u) => u.includes('daily-checkin')));
  } finally {
    h.cleanup();
  }
});

test('手动签到：未领取时真的领一次并提示成功', async () => {
  const h = loadHarness({ config: { autoCheckin: false }, secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    await h.commands.get('codebuddyquota.checkin')();
    assert.ok(h.fetchCalls.some((u) => u.includes('daily-checkin')));
    assert.ok(h.notifications.info.some((m) => m.includes('签到成功')));
    assert.strictEqual(h.notifications.error.length, 0);
  } finally {
    h.cleanup();
  }
});

test('签到提示不带领取数值，带账号昵称（超 5 字符用 ... 收尾）', async () => {
  const h = loadHarness({ config: { autoCheckin: false }, secrets: { manualToken: freshToken(3600, 'abcdefg') } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    await h.commands.get('codebuddyquota.checkin')();
    const msg = h.notifications.info.find((m) => m.includes('签到成功'));
    assert.ok(msg, '应有签到成功提示');
    assert.match(msg, /（abcde\.\.\.）/, msg);
    assert.ok(!/\+\s*\d/.test(msg), `提示里不该出现领取数值：${msg}`);
  } finally {
    h.cleanup();
  }
});

test('刷新失败后切主题不会用旧数据盖掉错误提示', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    h.setResponder(async (url) => (url.includes('get-user-resource') ? json({ code: 500 }, 500) : defaultResponder()(url)));
    await h.commands.get('codebuddyquota.refresh')();
    await settle(() => String(h.statusItems[0].tooltip).includes('积分读取失败'));
    h.fireThemeChange();
    await drain();
    assert.match(String(h.statusItems[0].tooltip), /积分读取失败/);
  } finally {
    h.cleanup();
  }
});

test('并发刷新被 in-flight 锁合并成一次取数', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    // 只数真正的取数请求：base 探测打的是同一路径但 PageSize 是 1
    let real = 0;
    const base = defaultResponder();
    h.setResponder(async (url, init) => {
      if (String(url).includes('get-user-resource') && String(init?.body ?? '').includes('"PageSize":200')) real++;
      return base(url, init);
    });
    const refresh = h.commands.get('codebuddyquota.refresh');
    await Promise.all([refresh(), refresh(), refresh()]);
    await drain();
    assert.strictEqual(real, 1, `并发刷新应只取一次数，实际 ${real}`);
  } finally {
    h.cleanup();
  }
});

test('同一次保存改 detailRows + autoCheckin：立刻重绘且不发请求', async () => {
  const h = loadHarness({ secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.statusItems[0].text.includes('760'));
    const before = h.fetchCalls.length;
    h.fireConfigChange(['codebuddyquota.detailRows', 'codebuddyquota.autoCheckin']);
    await drain();
    assert.strictEqual(h.fetchCalls.length, before, '不该发请求');
    assert.match(h.statusItems[0].tooltip.value, /积分数据/);
  } finally {
    h.cleanup();
  }
});

test('跨天后要重新签一次，旧签到状态不冒充今天', async (t) => {
  const day1 = new Date('2026-10-07T10:00:00+08:00').getTime();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: day1 });
  // token 有效期要盖过跨天那一刻，否则会先因登录态过期而提前返回
  const h = loadHarness({ secrets: { manualToken: freshToken(3 * 86400) } });
  try {
    h.ext.activate(h.context);
    await settle(() => h.fetchCalls.some((u) => u.includes('daily-checkin')));
    const first = h.fetchCalls.filter((u) => u.includes('daily-checkin')).length;
    assert.strictEqual(first, 1);
    t.mock.timers.setTime(day1 + 86400_000);
    await h.commands.get('codebuddyquota.refresh')();
    await drain();
    const second = h.fetchCalls.filter((u) => u.includes('daily-checkin')).length;
    assert.ok(second >= 2, `新的一天应重新签，实际 ${second} 次`);
  } finally {
    h.cleanup();
  }
});

test('保管箱读取报错时回落到取数链，而不是整轮崩掉', async () => {
  const h = loadHarness({ secretReadThrows: true });
  try {
    h.ext.activate(h.context);
    await settle(() => String(h.statusItems[0].tooltip).includes('未找到登录凭据'));
    assert.match(String(h.statusItems[0].tooltip), /未找到登录凭据/);
  } finally {
    h.cleanup();
  }
});

test('保管箱读缓存 Token 挂住时按超时放行，仍能用手动 Token 出数', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const h = loadHarness({ secretCacheReadHangs: true, secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await drain();
    t.mock.timers.tick(6000);
    await drain(60);
    assert.ok(h.statusItems[0].text.includes('760'), `应回落到手动 Token 出数，实际「${h.statusItems[0].text}」`);
  } finally {
    h.cleanup();
  }
});

test('保管箱读取挂住时按超时放行，状态栏不会被永久钉住', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
  const h = loadHarness({ secretReadHangs: true, secrets: { manualToken: freshToken() } });
  try {
    h.ext.activate(h.context);
    await drain();
    t.mock.timers.tick(6000);
    await drain(60);
    assert.match(String(h.statusItems[0].tooltip), /未找到登录凭据/);
  } finally {
    h.cleanup();
  }
});
