# CodeBuddy Quota

[English](README.en.md) | [简体中文](README.md)

Show your CodeBuddy credit balance in the status bar; hover to open the credit panel

![Quota card preview](resources/screenshot.png)

## Installation

Search for **CodeBuddy Quota** in your editor's marketplace

You can also install manually from the `.vsix` in [Releases](https://github.com/GhostCmdr/codebuddy-quota/releases/latest).

## Requirements

1. Install and sign in to Tencent Cloud CodeBuddy (`tencent-cloud.coding-copilot`) in VS Code or the VS Code-based IDE you are using
2. The extension reads the session saved by that extension from the **editor currently in use** — no need to copy cookies or tokens

- If automatic reading fails, set `codebuddyquota.manualToken` once as a fallback (a manually entered accessToken takes top priority; entering it again overwrites the previous one)
- To stop using the manual token, run the command CodeBuddy Quota: 清除保管箱里的手动 Token

## Features

- Status bar shows remaining credits live; click to refresh
- Hover panel: total remaining with percentage + per-pack detail, light theme supported
- Daily check-in and Buddy Travel
- Scheduled auto-refresh

## Settings

| Setting | Default | Description |
|---|---|---|
| `codebuddyquota.refreshInterval` | 30 | Auto-refresh interval in minutes, 0 disables |
| `codebuddyquota.autoCheckin` | true | Daily check-in |
| `codebuddyquota.buddyTravel` | true | Buddy Travel rewards |
| `codebuddyquota.detailRows` | 3 | Number of packs to show, sorted by expiry, 1~6 |
| `codebuddyquota.manualToken` | empty | Manual accessToken; entered once, then moved to the encrypted secret store |

## Commands

| Command | Effect |
|---|---|
| `CodeBuddy Quota: 刷新积分` | Fetch once immediately |
| `CodeBuddy Quota: 立即签到` | Manually claim today's check-in |
| `CodeBuddy Quota: 清除保管箱里的手动 Token` | Discard the manual token, fall back to the client session |

## Privacy

Credentials are read only from your machine and sent only to the official workbuddy.cn / codebuddy.cn domains; nothing is logged or uploaded. The manual token is stored in the encrypted secret store, leaving no plaintext in settings


## License

[MIT](LICENSE)
