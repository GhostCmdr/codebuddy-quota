import * as vscode from 'vscode';
import {
  fetchUsage, fetchCheckinStatus, doCheckin,
  fetchBuddyStatus, claimBuddy, departBuddy, fetchTravelRewardCredit, CreditsSummary, ApiError
} from './api';
import { configure as configureAuth, getAuth, invalidateAuth, TokenStore } from './auth';
import { currentHostStorage } from './providers/vscodeHost';
import { buildPanelData, buildTooltipMarkdown, footerHostPad, clampDetailRows } from './tooltip';
import { ensureCheckin, ensureBuddy, resetBuddyState, DayGuard } from './claim';
import { todayString, shouldCheckin, nextCheckinRetryAt, accountKeyOf } from './checkin';
import { jwtStringClaim } from './crypto';
import { fmtCredits } from './format';

const TOKEN_SECRET = 'manualToken';
const DEFAULT_REFRESH_MINUTES = 30;
const MAX_REFRESH_MINUTES = 1440;

/** globalState 里「最近一次领取成功的日期」的键名；按账号分桶存一个 day → day 的映射 */
const LAST_CHECKIN_DATE_KEY = 'codebuddyquota.lastCheckinSuccessDate';
const LAST_BUDDY_DEPART_DATE_KEY = 'codebuddyquota.lastBuddyDepartDate';

/** 改了必须重新取数的设置项；不在此列的只要按上一次数据重绘或不影响渲染 */
const REFRESH_KEYS = ['manualToken', 'refreshInterval'];
/** 既不参与渲染也不参与取数的设置项：拨动它只改变后续领取决策，本身不该触发任何请求 */
const NO_EFFECT_KEYS = ['autoCheckin', 'buddyTravel'];

let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
/** activate() 的上下文要留给之后的签到路径用（写 globalState 的日期守卫） */
let extContext: vscode.ExtensionContext | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
/** 当天兜底补签定时器：只在「今天还没领成」时排到当天 23:50，领成即销毁 */
let checkinTimer: NodeJS.Timeout | undefined;
let secretStore: vscode.SecretStorage | undefined;
let refreshing = false;
let pendingRefresh = false;
/** 同一时刻只允许一次签到，避免启动刷新与手动命令叠加 */
let claiming = false;

let lastSummary: CreditsSummary | undefined;
let lastCheckinState = 'unknown';
let lastCheckinDay = '';
let lastFetchedAt = 0;
let clearingTokenSetting = false;

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('codebuddyquota');
}

function log(message: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() ? raw : '未知错误';
}

/**
 * 提示语里区分账号用：优先 token 里的 nickname，超过 5 个字符用 ... 收尾。
 * 不额外请求接口——昵称本来就在 JWT 里；没有就不带括号。
 */
function accountLabel(token: string): string {
  const name = jwtStringClaim(token, 'nickname');
  if (!name) return '';
  return name.length > 5 ? `${name.slice(0, 5)}...` : name;
}

/**
 * 日期守卫：值按账号分桶存在 globalState 里。
 * 桶名用 token 摘要（凭证里没有稳定 userId），同一份登录态跨重启稳定、换账号必然不同。
 */
function guardFor(key: string, accountKey: string): DayGuard {
  const read = (): Record<string, unknown> => {
    const stored = extContext?.globalState.get<unknown>(key);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      return { ...(stored as Record<string, unknown>) };
    }
    return {};
  };
  return {
    lastDate: () => {
      const value = read()[accountKey];
      return typeof value === 'string' ? value : undefined;
    },
    record: async (day) => {
      await extContext?.globalState.update(key, { ...read(), [accountKey]: day });
    }
  };
}

function makeTokenStore(): TokenStore {
  return {
    get: async () => {
      const raw = await secretStore!.get('cachedAccessToken');
      if (!raw) return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    set: async (v) => {
      if (v) await secretStore!.store('cachedAccessToken', JSON.stringify(v));
      else await secretStore!.delete('cachedAccessToken');
    }
  };
}

async function storedManualToken(): Promise<string> {
  if (!secretStore) return '';
  const pending = Promise.resolve(secretStore.get(TOKEN_SECRET));
  pending.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    const stored = await Promise.race([
      pending,
      new Promise<never>((_res, reject) => {
        timer = setTimeout(() => reject(new Error('读取超过 5s 未返回')), 5000);
      })
    ]);
    return (stored || '').trim();
  } catch (err) {
    log(`保管箱读取失败（${messageOf(err)}），本次改用自动读取`);
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sweepManualToken(): Promise<boolean> {
  if (!secretStore) return false;
  const raw = (cfg().get<string>('manualToken') || '').trim();
  if (!raw) return false;
  try {
    await secretStore.store(TOKEN_SECRET, raw);
  } catch (err) {
    log(`保管箱写入失败（${messageOf(err)}）`);
    return false;
  }
  clearingTokenSetting = true;
  try {
    await clearManualTokenSetting();
    await new Promise((r) => setImmediate(r));
  } finally {
    clearingTokenSetting = false;
  }
  log('手动 Token 已存入加密保管箱，设置项已清空');
  return true;
}

async function clearManualTokenSetting(): Promise<void> {
  const scope = cfg().inspect<string>('manualToken');
  const targets: Array<[string | undefined, vscode.ConfigurationTarget]> = [
    [scope?.workspaceFolderValue, vscode.ConfigurationTarget.WorkspaceFolder],
    [scope?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [scope?.globalValue, vscode.ConfigurationTarget.Global]
  ];
  for (const [value, target] of targets) {
    if (!value || value.trim() === '') continue;
    try {
      await cfg().update('manualToken', undefined, target);
    } catch (err) {
      log(`Token 已存保管箱，但清空设置项失败（${messageOf(err)}），请手动删 settings.json 里的明文`);
    }
  }
}

async function clearManualToken(): Promise<void> {
  if (!secretStore) return;
  try {
    const stored = await secretStore.get(TOKEN_SECRET);
    if (!stored) {
      vscode.window.showInformationMessage('CodeBuddy Quota：保管箱里没有手动 Token，当前用自动读取');
      return;
    }
    await secretStore.delete(TOKEN_SECRET);
  } catch (err) {
    vscode.window.showErrorMessage(`CodeBuddy Quota：清除保管箱 Token 失败（${messageOf(err)}）`);
    return;
  }
  log('已清除保管箱里的手动 Token');
  await reconfigureAuth();
  await refresh(false);
}

async function reconfigureAuth(): Promise<void> {
  configureAuth({
    manualToken: await storedManualToken(),
    store: makeTokenStore(),
    // 只从当前编辑器取登录态：宿主 User 目录由本扩展自己的 globalStorage 位置反推
    hostStorage: extContext ? currentHostStorage(extContext.globalStorageUri.fsPath) : undefined
  });
  invalidateAuth(true);
}

function refreshIntervalMinutes(): number {
  const raw = cfg().get<unknown>('refreshInterval');
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') return DEFAULT_REFRESH_MINUTES;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return DEFAULT_REFRESH_MINUTES;
  return Math.min(Math.max(Math.trunc(minutes), 0), MAX_REFRESH_MINUTES);
}

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  const minutes = refreshIntervalMinutes();
  if (minutes <= 0) {
    log('已关闭积分自动刷新');
    return;
  }
  refreshTimer = setInterval(() => {
    // 回调没人等它的 promise，异常只能就地记下，否则是一颗 floating rejection
    void refresh(false).catch((err) => log(`定时刷新失败：${messageOf(err)}`));
  }, minutes * 60 * 1000);
}

/** 手改成非法值不静默变成关闭，按默认开启处理 */
function autoCheckinEnabled(): boolean {
  const raw = cfg().get<unknown>('autoCheckin');
  return typeof raw === 'boolean' ? raw : true;
}

function clearCheckinTimer(): void {
  if (checkinTimer) {
    clearTimeout(checkinTimer);
    checkinTimer = undefined;
  }
}

/**
 * 编辑器一直开着跨过零点时，靠这个定时器补领。只在「当天还没领成」时存在，
 * 全天最多醒一次，领成即销毁——不做任何轮询。
 */
function scheduleCheckinRetry(): void {
  if (!autoCheckinEnabled()) return;
  clearCheckinTimer();
  const now = new Date();
  const delayMs = nextCheckinRetryAt(now).getTime() - now.getTime();
  checkinTimer = setTimeout(() => {
    checkinTimer = undefined;
    void refresh(false).catch((err) => log(`定时补签失败：${messageOf(err)}`));
  }, delayMs);
}

function themeKind(): 'light' | 'dark' {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? 'light' : 'dark';
}

function renderStatusBar(): void {
  if (!lastSummary) return;
  const hhmm = new Date(lastFetchedAt || Date.now()).toTimeString().slice(0, 5);
  // 跨天后旧签到状态作废，回落「签到未查询」（对齐 traecn）
  const checkin = lastCheckinDay === todayString() ? lastCheckinState : 'unknown';
  const data = buildPanelData(lastSummary, checkin, hhmm);
  statusBar.text = lastSummary.unlimited
    ? '$(codebuddy-sparkle) ∞'
    : `$(codebuddy-sparkle) ${fmtCredits(lastSummary.remain)} (${data.pct}%)`;
  const md = new vscode.MarkdownString(buildTooltipMarkdown(data, {
    detailRows: clampDetailRows(cfg().get('detailRows', 3)),
    appName: vscode.env?.appName,
    theme: themeKind()
  }));
  md.isTrusted = true;
  md.supportHtml = true;
  statusBar.tooltip = md;
  statusBar.backgroundColor = undefined;
  statusBar.command = 'codebuddyquota.refresh';
  statusBar.show();
}

function renderErrorStatus(msg: string): void {
  statusBar.text = '$(codebuddy-sparkle) --';
  statusBar.tooltip = `CodeBuddy 积分读取失败\n\n${msg}`;
  statusBar.command = 'codebuddyquota.refresh';
  statusBar.show();
}

async function refresh(verbose: boolean): Promise<void> {
  if (refreshing) {
    if (verbose) vscode.window.showInformationMessage('CodeBuddy Quota：正在刷新中');
    else pendingRefresh = true;
    return;
  }
  refreshing = true;
  try {
    statusBar.text = '$(sync~spin) 刷新中…';
    const auth = await getAuth();
    if (auth.mode === 'none') {
      renderErrorStatus('未找到登录凭据。请在当前编辑器里登录 CodeBuddy 扩展，或在设置项 codebuddyquota.manualToken 填一次 accessToken');
      return;
    }
    const accountKey = accountKeyOf(auth.token);
    const autoCheckin = autoCheckinEnabled();
    const buddyTravel = cfg().get<boolean>('buddyTravel', true);

    const checkinP = autoCheckin
      ? ensureCheckin(auth, { status: fetchCheckinStatus, checkin: doCheckin }, guardFor(LAST_CHECKIN_DATE_KEY, accountKey))
      : Promise.resolve({ state: 'unknown' as const });
    const buddyP = ensureBuddy(
      auth,
      { status: fetchBuddyStatus, claim: claimBuddy, depart: departBuddy, rewardCredit: fetchTravelRewardCredit },
      buddyTravel,
      guardFor(LAST_BUDDY_DEPART_DATE_KEY, accountKey)
    );

    const [checkin, buddy] = await Promise.all([checkinP, buddyP]);
    lastCheckinState = checkin.state;
    lastCheckinDay = todayString();
    if (checkin.state === 'claimed' || checkin.state === 'unclaimed') {
      clearCheckinTimer();
    } else {
      // 没领成（接口异常或查询失败）就排一次当天的兜底补领；自动领取按定稿保持静默，只写日志
      if (autoCheckin) {
        log(`签到未完成${'error' in checkin && checkin.error ? `：${checkin.error}` : ''}`);
        scheduleCheckinRetry();
      }
    }
    if (buddy) {
      if (buddy.error) log(`喵喵旅行异常：${buddy.error}`);
      else if (buddy.claimedCredit != null || buddy.departedHours != null) {
        const parts: string[] = [];
        if (buddy.claimedCredit != null) parts.push(`领取 ${buddy.claimedCredit}`);
        if (buddy.departedHours != null) parts.push(`派出 ${buddy.departedHours}h`);
        log(`喵喵旅行：${parts.join('，')}`);
      }
    }

    const summary = await fetchUsage(auth);
    lastSummary = summary;
    lastFetchedAt = Date.now();
    renderStatusBar();
    if (verbose) {
      const quota = summary.unlimited ? '不限量' : `剩余 ${fmtCredits(summary.remain)}`;
      vscode.window.showInformationMessage(`CodeBuddy Quota：${quota}`);
    }
  } catch (err) {
    const api = err as Partial<ApiError>;
    const msg = messageOf(err);
    // 丢掉上一轮数据：否则失败后换主题/改 detailRows 会按旧数据重绘，把错误提示盖掉
    lastSummary = undefined;
    if (api.code === 'NO_CREDENTIALS') renderErrorStatus('未找到登录凭据');
    else if (api.code === 'AUTH_EXPIRED') {
      invalidateAuth(true);
      renderErrorStatus('登录已过期，请重新登录 CodeBuddy 扩展');
    } else {
      renderErrorStatus(msg);
    }
    // 接口正文只进输出面板，绝不进 tooltip 与 toast
    log(`刷新失败：${msg}${api.remoteDetail ? `｜接口返回：${api.remoteDetail}` : ''}`);
    if (verbose) vscode.window.showErrorMessage(`CodeBuddy Quota 刷新失败：${msg}`);
  } finally {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      // 兜的是 catch/finally 那一段的意外抛出——floating rejection 会直接终止进程
      void refresh(false).catch((err) => log(`补刷失败：${messageOf(err)}`));
    }
  }
}

/**
 * 手动补签（命令入口）。只有这条路径弹 toast：自动领取按用户定稿保持静默，只写输出面板。
 */
async function manualCheckin(): Promise<void> {
  if (claiming) {
    vscode.window.showInformationMessage('CodeBuddy Quota：正在签到中，请稍候');
    return;
  }
  claiming = true;
  try {
    const auth = await getAuth();
    if (auth.mode === 'none') {
      vscode.window.showWarningMessage('CodeBuddy Quota：未找到登录凭据，无法签到');
      return;
    }
    const guard = guardFor(LAST_CHECKIN_DATE_KEY, accountKeyOf(auth.token));
    const day = todayString();
    if (!shouldCheckin(guard.lastDate(), day)) {
      vscode.window.showInformationMessage('CodeBuddy Quota：今日已签到，无需重复领取');
      await refresh(true);
      return;
    }
    const r = await ensureCheckin(auth, { status: fetchCheckinStatus, checkin: doCheckin }, guard);
    if (r.state === 'claimed') {
      clearCheckinTimer();
      // 提示里不带领取数值（对齐 traecn）：数值每天不同，说了反而像承诺
      const who = auth.token ? accountLabel(auth.token) : '';
      const tag = who ? `（${who}）` : '';
      log(`${day} 手动签到成功${tag}`);
      vscode.window.showInformationMessage(`CodeBuddy Quota：签到成功${tag}`);
      await refresh(true);
    } else {
      log(`${day} 手动签到失败${r.error ? `：${r.error}` : ''}`);
      vscode.window.showErrorMessage(`CodeBuddy Quota：签到失败${r.error ? `：${r.error}` : ''}`);
      scheduleCheckinRetry();
    }
  } catch (err) {
    log(`手动签到异常：${messageOf(err)}`);
    vscode.window.showErrorMessage(`CodeBuddy Quota：签到失败：${messageOf(err)}`);
  } finally {
    claiming = false;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  secretStore = context.secrets;
  output = vscode.window.createOutputChannel('CodeBuddy 积分');
  output.appendLine('提示：本面板的失败详情可能含账号信息，对外求助前请先删掉这些行。');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'codebuddyquota.refresh';
  statusBar.text = '$(codebuddy-sparkle) --';
  statusBar.tooltip = 'CodeBuddy 积分：正在加载…';
  statusBar.show();

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('codebuddyquota.refresh', () => refresh(true)),
    vscode.commands.registerCommand('codebuddyquota.checkin', () => manualCheckin()),
    vscode.commands.registerCommand('codebuddyquota.clearManualToken', () => clearManualToken()),
    vscode.window.onDidChangeActiveColorTheme(() => {
      // SVG 配色写死，换主题必须重绘，否则浅色主题下白字白底
      if (lastSummary) renderStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('codebuddyquota')) return;
      const tokenChanged = event.affectsConfiguration('codebuddyquota.manualToken');
      const tokenStillSet = (cfg().get<string>('manualToken') || '').trim() !== '';
      // 自己清空设置项荡回来的回声不需要做任何事（其它窗口认不出回声，代价只是多刷一次）
      if (tokenChanged && clearingTokenSetting && !tokenStillSet) return;
      const refreshKeyChanged = REFRESH_KEYS.some(
        (key) => key !== 'manualToken' && event.affectsConfiguration(`codebuddyquota.${key}`)
      );
      // 只动了领取开关（既不影响渲染也不影响取数）时整轮跳过：拨一次开关就打一次接口是打扰
      const noEffectOnly = !tokenChanged && !refreshKeyChanged
        && NO_EFFECT_KEYS.some((key) => event.affectsConfiguration(`codebuddyquota.${key}`));
      // detailRows 只影响展示：用上次数据重绘、不再打接口；优先级高于下面 noEffect 的短路
      const displayOnly = !tokenChanged && !refreshKeyChanged
        && event.affectsConfiguration('codebuddyquota.detailRows');
      void (async () => {
        if (displayOnly) {
          renderStatusBar();
          return;
        }
        if (noEffectOnly) return;
        if (tokenChanged) await sweepManualToken();
        if (tokenChanged) await reconfigureAuth();
        scheduleRefresh();
        await refresh(false);
      })().catch((err) => log(`处理设置变更时出错：${messageOf(err)}`));
    })
  );

  scheduleRefresh();

  void (async () => {
    await sweepManualToken();
    await reconfigureAuth();
    resetBuddyState();
    const auth = await getAuth();
    const hostPad = footerHostPad(vscode.env?.appName);
    // 宿主识别诊断：浮窗页脚底距按 appName 分流，若底距不对，先看这行的实际值
    log(`宿主 appName="${vscode.env.appName}"，浮窗页脚底距补偿 hostPad=${hostPad}`);
    // 冷启动补偿：当天还没领成（比如编辑器整天没开过）时排一次当天 23:50 的兜底
    if (autoCheckinEnabled() && auth.mode !== 'none') {
      const guard = guardFor(LAST_CHECKIN_DATE_KEY, accountKeyOf(auth.token));
      if (shouldCheckin(guard.lastDate(), todayString())) {
        scheduleCheckinRetry();
      }
    }
    await refresh(false);
  })().catch((err) => log(`启动刷新失败：${messageOf(err)}`));
}

export function deactivate(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
  clearCheckinTimer();
}
