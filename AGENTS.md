# AGENTS.md — 本仓库的开发规范

CodeBuddy Quota：VS Code 系扩展，状态栏显示 CodeBuddy 积分余量 + 悬停浮窗 + 自动每日签到。源码在 `src/`（零运行时依赖），产物在 `out/`。**本文件即本项目唯一的开发规范**（原先 `documents/designs/` 下的那几份已于 2026-10-07 并入本文件并删除）。

同族参考实现：`../traecn-quota/traecn-quota`（作者自己的另一个扩展，UI 与骨架的蓝本）。

---

# 一、悬浮浮窗的版式与配色

改 `src/tooltip.ts` 的坐标/字号/配色前读这一节。版式与 traecn-quota 的 `buildTooltipBody` 同源（那套已多宿主实测），本家只换了标题文案、用量图标与「不限量」的数据来源。**改完必须跑 `npm run test:layout`**。

## 约束前提
- 状态栏 tooltip 只渲染 Markdown：无 CSS、无 HTML 样式，唯一能上真彩的手段是内联 `data:image/svg+xml;base64,` 图片
- SVG 图片内部不能挂点击事件，所以可点击图标必须放在 Markdown 层

## 结构（两层）
1. `### CodeBuddy 积分面板` 标题行：右侧三个 `align="right"` 的 `<a href>` + `<img>`（DOM 序 齿轮 / 刷新 / 用量明细，14px）。float:right 按 DOM 序从右往左排，视觉上从左到右是 **齿轮 · 刷新 · 用量**
2. 透明背景 SVG 数据体：大数字 + 分母 → 百分比胶囊 → 进度条 → 表头 → 明细行 → 页脚

## 纵向栅格：墨迹间距 GAP=10
**按墨迹（笔画真正出现的像素行）算，不是字体盒。** 像素行是闭区间，所以「10 行空白」= 下一元素墨迹顶行 = 上一元素墨迹底行 + 11（代码里的 `STEP`）。

| 元素 | 基线上 | 基线下 |
|---|---|---|
| 30px 大数字（700 字重） | 22 | 3 |
| 10~11px 中英混排 | 9 | 1 |
| 进度条 / 分隔线 | 高 5 / 高 1 行 | — |

链式定位由 `tooltipLayout` 里的 `NUM_ASC/NUM_DESC/TXT_ASC/TXT_DESC/BAR_ROWS/LINE_ROWS/STEP/NUM_TOP_PAD` 推导，勿写死坐标。

`preview/measure-pixels.js` 实测的 13 处间距（3 行明细、VSCode 外壳）：

```
14 外框顶→标题 · 13 标题→大数字 · 10 数字→进度条 · 10 进度条→表头 · 5 表头→表头分隔线
每行两段 10/10（无逗号的行是 10/11）· 末行分隔线→页脚 10 · 页脚→浮窗下边缘 10
```

两处到不了 10 是外部/内容约束：
- **外框顶→标题 14**：VSCode 的 1px 边框 + 4px padding + h3 的 8px margin，插件控制不了
- **标题→大数字是 13（traecn 那边是 15）**：本家标题 `CodeBuddy 积分面板` 里的 **`y` 有下伸**，把标题墨迹底压低 2 行。**改标题文案必须同步改 `measure-pixels.js` 的 EXPECTED[1]**
- 「行 → 其下分隔线」在该行没有逗号等下伸字符时实测 11，属内容相关，无法用固定常量消除（EXPECTED 已按 11 记录）

SVG 整体带 `transform="translate(0,0.3)"`：不补齐的话 1px 分隔线会被抗锯齿糊成两行，实测间距在 10/11 之间跳。

## 尺寸
- 画布宽 `W = 251.7`；高度链式跟随行数：`H = footBase + 12 − footerHostPad`
- 3 行明细时：SVG **192**，VSCode 外框 **239**
- 1~6 行的 SVG 高（VSCode 宿主）：**128 / 160 / 192 / 224 / 256 / 288**；Trae 系各多 5（133 / 165 / 197 / 229 / 261 / 293）

## 页脚底距与宿主
数据体是行内 `<img>`，「页脚墨迹→浮窗下边缘」由两段拼成：SVG 自带的 10.7 − hostPad，加上宿主在行内图下方额外补的量。宿主补多少读不到，只能按 `appName` 分流：

| 宿主 | 契约 hostPad | 取值 |
|---|---|---|
| Trae CN / TRAE SOLO CN | 4.1 | **4** |
| VS Code 及其余未识别宿主 | 8.6 | **9** |

未识别的回落 9。本机另外三家（Qoder CN IDE / CodeBuddy CN / CodeArts Agent）的 hover 规则与 VS Code 一致，回落对它们成立。**换市场装插件后如果底距不对**：看输出面板启动那行 `宿主 appName=… 页脚底距补偿 hostPad=…`，再用 `node preview/measure-host-gap.js <真机截图.png> <该构建的 hostPad>` 反推实际值。

## 横向：两列字面间距 20px
- 额度列右锚 `QUOTA_RIGHT = 145.6`；名称列格数由 `nameCells(额度串)` 反推（`CELL_PX = 5.5`，夹在 6~11 格）
- 减 `ELLIPSIS_EXTRA_PX = 3`：省略号墨迹 8.5px 而 `displayWidth` 只记 1 格（5.5px），不预留会跌破 20
- `textPx` 用的推进宽度表见 `glyphPx`；**注意** `preview/measure-glyphs.js` 量的是 getBBox 墨迹（含悬垂），不等于推进宽度，只作交叉核对、**不要拿它改表**

## 配色与主题
- 调色板成对定义在 `paletteFor('light' | 'dark')`：strong / body / muted / track / divider / rowLine / **accent / accentMid / accentLow / pill / pillMid / pillLow**
- **进度条与百分比胶囊按余量分三档变色**（定稿阈值 **60 / 20**）：

  | 余量 | 进度条 | 胶囊 |
  |---|---|---|
  | `> 60%` | `accent` 蓝 | `pill` 蓝 |
  | `20% ~ 60%` | `accentMid` 橙 | `pillMid` 橙 |
  | `≤ 20%` | `accentLow` 红 | `pillLow` 红 |

  不限量时 pct 记 100 → 走蓝档
- **明细行文字不变色**（只按总占比给进度条与胶囊上色），与 traecn 一致
- 胶囊 44×22 rx=11，实心底白字（三档底色都够深，白字恒定）
- SVG 颜色写死，必须跟随 `activeColorTheme.kind`，并在 `onDidChangeActiveColorTheme` 里用 `lastSummary` 重绘，否则浅色主题白字白底

## 不限量
- 整体不限量：大数字显示 `∞`、分母位「不限量」、胶囊 `∞`、进度条满格、状态栏 `∞`、刷新提示说「不限量」
- 明细行里的不限量包显示 `∞ / 不限量`
- 混合（有限额 + 不限量）时整体**不**判不限量，按有限额部分算占比（`api.ts` 一处决定）

## 文字处理
- CJK 全角按 2 格宽（`displayWidth`），`truncate` 超出补 `…`
- 套餐名不是字符串（数字/对象）时在 `api.ts` 回落成 `-`：不挡的话它会一路进 SVG 渲染并抛 `TypeError`

## 浮窗的校验（不要靠肉眼，也不要靠 getBBox——那是字体盒不是墨迹）
`buildTooltipSvg` / `paletteFor` / `tooltipLayout` 均已导出，预览脚本直接 require `out/tooltip.js`，量的是**出厂代码**，严禁复制第二份 builder：
- `node preview/measure-pixels.js [--check]` — 截图后逐行扫真实墨迹带，断言 13 处纵向间距（`npm run test:layout` 已带 `--check`）
- `node preview/measure-columns.js` — 四个量级 × 9 字名称压上限，断言字面间距 ≥20px 且大数字右缘 ≤187.7px（`npm run test:layout` 已带）
- `node preview/render-panel.js` — 出 `preview/_panel-dark.png` / `_panel-light.png` 明暗对照 + `preview/_panel-shot.png`（面板本体）。**它不写 `resources/screenshot.png`**，那张是真机截图、由用户提供，别覆盖
- `node preview/measure-glyphs.js` — 11px 字形**墨迹**宽，仅供交叉核对（见上）
- `node preview/measure-host-gap.js <真机截图.png> [hostPad]` — 从真机截图反推宿主底距
- `preview/png.js` — 纯 zlib 的 8bit RGB/RGBA PNG 解码（不引 sharp），上面两个截图脚本共用
- `preview/chrome.js` — Chrome/Chromium 自动探测（`CHROME_PATH` → 常见路径 → which）

---

# 二、凭证取源

改 `src/auth.ts` / `src/providers/` 之前读这一节。

## 取源顺序
1. 设置项 `codebuddyquota.manualToken` 填过一次 → 收进编辑器加密保管箱，**永远最高优先**
2. 保管箱里没有手动 Token 时，读**当前这个编辑器**的登录态：`<userData>/User/globalStorage/state.vscdb`，用同宿主 `Local State` 里的密钥解密。`<userData>` 由本扩展自己的 `globalStorageUri` 反推（`currentHostStorage`）——既不用猜 appName 与目录名的对应关系，也不可能读到别的编辑器
3. 两者都拿不到就直接报「未找到登录凭据」，**不退到任何明文 Token 文件**：那些文件不保证属于同一账号与同一环境，拿它兜底只会把「没登录」伪装成「认证失败」

**不要再改回「按顺序扫一串宿主目录」**：候选集一多，「用的是哪个账号」就不再可控。代价是：在没登录 CodeBuddy 的编辑器里读不到凭据，只能用手动 Token 兜底。

## 两家宿主的键名不一样（必须都认）

| 宿主 | `state.vscdb` 里的键名 |
|---|---|
| VS Code / Trae / Trae CN | `Tencent-Cloud.coding-copilot.new.accessToken` |
| 官方 CodeBuddy CN IDE | `planning-genie.new.accessTokencn` |

外层都是 `secret://{"extensionId":"tencent-cloud.coding-copilot","key":"<键名>"}`，走同一套 DPAPI / v10 解密。**只认前者会让官方 IDE 直接读不到登录态**（2026-10-07 实测：两个键名按序取之后，Code / Trae CN / Trae / CodeBuddy CN 四家都能取到 token）。

## 其余约束
- **删除保管箱只能走显式命令**：把设置项 `manualToken` 删空**不会**清除保管箱里那份。同 profile 多个窗口能互相看到设置变更，靠「设置项变空」推断用户想删除会误删别的窗口刚存的凭证 → 删除只能由命令 **CodeBuddy Quota: 清除保管箱里的手动 Token** 触发
- **请求目标收窄到白名单**：`ALLOWED_CREDENTIAL_ORIGINS` 只认精确 origin（`https://www.workbuddy.cn`、`https://www.codebuddy.cn`），不放开 `*.` 通配（任意子域，含悬垂 CNAME 的废弃环境，都能收走请求头里的凭证）；`ALLOWED_BILLING_BASES` 同样只从白名单取，`api.ts` 的 `authFetch` 拼好 URL 后还会调 `assertAllowedCredentialTarget` 再断言一次。新增任何取源都不该拆掉这一步
- **不回显设置项原值**：`manualToken` 之类是用户手可改的 `settings.json`，schema 约束不住；那串会进浮窗或弹窗，含 `[]()` 的恶意值能拼出可点外链
- **失败原因不写本机路径**：宿主扫描失败的原因串可能带 `%APPDATA%` 与用户名，而用户常整段截图求助 → `providers/vscodeHost.ts` 统一把 home / APPDATA 前缀替换成 `~` 再记录
- 读宿主保管箱有 **5 秒上限**（`bounded()`）：卡住时不能把整轮刷新永久钉在「刷新中…」

---

# 三、CHANGELOG.md 怎么写

它有**三处受众，全是装插件的人**：① 打包进 vsix → 编辑器扩展详情页的「更新日志」标签；② 市场页 Changelog；③ CI 用 awk 抓 `## <version>` 整段当 **GitHub Release 正文**（`.github/workflows/publish.yml`）。

- 版本号顶格、形如 `## 0.1.0`，**新版本放最上面**；标题下空一行，先写一行总结（40 字以内，句末不加标点）
- 小节用 `### 新增` / `### 优化与修复`（首版用 `### 功能`），只建本版涉及的；每条 `- ` 起头、一条一句、句末不加标点、**不写文件名与实现细节**
- 非用户能感知的改动（文档、CI、构建、内部重构）：`### 优化与修复` 只写一行「解决了一些已知问题，奖励自己一杯×× 😏」
- **不写**：文档措辞、市场分类、下载渠道、CI、构建脚本、忽略规则
- 同一条改动别在 `### 新增` 和 `### 优化与修复` 里各写一遍
- **这份文件里不要放 HTML 注释或任何只给开发者看的内容** —— 它会随包发给用户

---

# 四、版本号与发布

## 渠道

| 渠道 | 标识 | 怎么发 |
|---|---|---|
| 微软 Marketplace | `GhostCmdr.codebuddy-quota` | 推 `v*` tag，CI 自动 `vsce publish` |
| Open VSX | 同上 | 同一个 tag，CI 用长期令牌 `OVSX_PAT` 发布 |
| GitHub Release | — | 同一个 tag，CI 打包后把 `.vsix` 挂成附件 |
| 国产 IDE 市场（Qoder CN / Trae CN / CodeArts / CodeBuddy） | 同上 | 本地 `npm run package` 出 `.vsix` 后在各市场面板自助上传，不走 CI |

GitHub Release 的 `.vsix` 附件排在「发市场」之前：国产 IDE 的扩展面板未必搜得到微软市场，这个附件是那部分用户的兜底下载口，不该被市场发布失败连带跳过。

## 纪律
- tag 形如 `v0.1.0`，必须与 `package.json` 的 `version` **以及 `package-lock.json` 顶层 `version`** 三者一致，否则 CI 直接拒发（lockfile 失配时 `npm ci` 不会报错，是最容易漏的一处）
- CHANGELOG 里要有一个 `## <version>` 段；没有小节时 Release 正文回落成「本版无功能变更」
- **打 tag 就是发布**：`publish.yml` 的触发条件是 push `v*` tag，不判断分支、不看有没有升版 → **别拿 `v*` tag 当备份或给旧提交做标记**
- 推之前确认三件事：`package.json` 已升版、lockfile 顶层 `version` 对齐、CHANGELOG 有对应版本段
- 本机反复装同名 `.vsix` 迭代 UI 要 `--force`；**但发版必须升 `version`**，不升就会撞上市场里「已存在则跳过」，等于什么都没发
- 提交、推送、打 tag 都由用户决定：**不要自行 `git commit` / `git push` / 建 tag**

## 凭据
| 用途 | 凭据 |
|---|---|
| Marketplace | 仓库 secret `VSCE_PAT`（长期令牌） |
| Open VSX | 仓库 secret `OVSX_PAT`（长期令牌） |
| GitHub Release | Actions 自带的 `GITHUB_TOKEN` |

Open VSX 不用「受信发布（OIDC）」的原因：那里的登记绑在**已存在的扩展**上，首发时扩展还没上线、登记页选不到它。等上线后想换受信发布，再回来登记并去掉 secret。`OVSX_PAT` 为空时 `ovsx` 会**假绿**（打印「PAT valid」并返回 0，其实什么都没发），所以发布步骤有一道显式拦截：secret 为空直接红——这一步必须排在「版本已存在则跳过」之后，否则重复推 tag 时会因没配 secret 误红。

---

# 五、每轮收尾

- `npm test` 必须全绿（单测 + `preview/measure-pixels.js --check` 纵向门禁 + `preview/measure-columns.js` 横向门禁）
- 再 `npm run package` 出 vsix（**打包 ≠ 提交**）
- **删过 `.ts` 之后先 `rm -rf out && npm run compile` 再打包**：`tsc` 不清理已删源文件的产物，否则死代码会被打进 vsix

# 六、用户可见文档的口径

- `README.md` / `README.en.md` / `CHANGELOG.md` 只写**用户能感知的功能改动**，不写内部改动、不写操作教学
- 中英双语逐段同步（`README.en.md` ↔ `README.md`）
- 市场页配图是 `resources/screenshot.png`（**真机截图，由用户提供**）

# 七、仓库边界

- `preview/`、`legacy/` 与本文件 `AGENTS.md` 都**不进 vsix**（见 `.vscodeignore`），别把它们移出忽略名单
- `legacy/capsule-0.1.0-tooltip.js` 是胶囊版唯一幸存副本，**别删**
