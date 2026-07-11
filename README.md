# Claude Usage Dashboard 🏎️

A floating "luxury-car instrument cluster" desktop widget that shows your Claude
usage in real time — session (5-hour), weekly, and a dedicated **Fable-5 weekly**
gauge. All data is **100% local**: it parses your Claude Code transcripts under
`~/.claude/projects` (JSONL). No network, no credentials touched.

一个悬浮在桌面上的「豪车仪表盘」小组件,实时显示你的 Claude 用量(5 小时 session、周用量、以及专门的 Fable-5 周用量)。数据**完全本地**:解析 `~/.claude/projects` 下的会话记录,不联网、不碰任何凭据。

![preview](docs/preview.png)

> **Windows-first.** Built and tested on Windows 11 with Electron. The core
> scanner is plain Node and should work cross-platform; the tray icon path and
> the auto-start snippet are Windows-specific.

## Download (no Node needed)

Grab the prebuilt Windows `.exe` from the
[**Releases**](https://github.com/rxdage/claude-usage-dashboard/releases) page:

- **`…-setup.exe`** — installer (adds a Start-menu entry).
- **`…-portable.exe`** — single-file, just double-click to run.

Builds are produced automatically by GitHub Actions on each tagged release.

## Run from source

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/rxdage/claude-usage-dashboard.git
cd claude-usage-dashboard
npm install
npm start
```

To build the `.exe` yourself: `npm run dist` (output in `dist/`).

> **In mainland China**, if the Electron binary download stalls, set the mirror
> first: `set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` (PowerShell:
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`) then `npm install`.

- Frameless, transparent, always-on-top. Drag it anywhere — it **snaps to
  screen edges** and remembers its position.
- Hover the top-right for `–` (hide to tray) / `×` (quit). Tray icon right-click
  also quits. Relaunching just reveals the existing window (single instance).
- Rescans transcripts every 3 seconds (incremental).

## Layout (300 × 118)

| Area | Meaning |
|---|---|
| **SESSION** (left tachometer) | Current 5-hour rolling window usage %. Redline ≥80% turns the digital % red. Center shows %, tokens, and countdown to reset. Window algorithm matches ccusage. |
| **FABLE·5 WK** (top bar) | Fable-5 weekly usage. **Once calibrated** it shows "X% left" as a green→amber→red fuel bar; uncalibrated it shows "used · set limit" with an amber bar of Fable's share of the week. |
| **ALL WK** (middle bar) | All-model weekly usage, same behavior. |
| **Footer** | Today's cost, countdown to the **weekly reset** (Mon 09:00), green `●` activity lamp (lit within 90s of a request; turns red on a scan error). |

Set `"opacity": 0.9` in `config.json` to make the window translucent.

## Making the numbers match `/usage` — calibrate once

The widget can't read the official quota numbers (that needs an OAuth token, kept
in the OS credential store). So you calibrate once against `/usage`, and the bars
then show real "remaining". The weekly window is anchored to the same **Monday
09:00 reset** as Claude, so one calibration holds for the whole week.

**Easiest — the tray button (works for the .exe too):** right-click the tray icon
→ **Calibrate…**. A small window opens; run `/usage` in Claude Code and type the
percentages it shows (Fable weekly, All weekly, and/or 5-hour), then click
**Apply**. The bars update instantly. No command line, no file editing.

**From source, one command:** run `/usage`, then:

```bash
npm run cal -- <Fable weekly %> <All weekly %> [session %]
# e.g. /usage shows Fable 21%, all 17%, 5h 33%:
npm run cal -- 21 17 33
```

Either way it reads your current usage, back-solves the limits, writes
`config.json`, and the widget picks it up within ~3s (no restart).

### Why "cost-weighted" instead of raw token count

Usage is metered **cost-weighted** by default (`"metric": "cost"`), not raw tokens.
Reason: in practice ~96% of your tokens are **cache reads**, which cost only 0.1× of
input — the official `/usage` clearly doesn't count them 1:1, or a cache-heavy
session would blow through your quota instantly. Cost-weighting discounts cache
reads the same way pricing does, which lines up with `/usage`.

Cost is estimated at API list prices (cache write 1.25×/2×, cache read 0.1× input):
Fable $10/$50 · Opus 4.x $5/$25 · Sonnet $3/$15 · Haiku 4.5 $1/$5 per MTok. The "$"
here is a **weighting unit**, not what your subscription actually bills.

### `config.json` reference

`config.json` is created automatically (it stores window position too) and is
**git-ignored** — it holds your personal calibration.

- **Run from source:** it lives in the project folder next to `package.json`.
- **Prebuilt `.exe`:** it lives in your user data folder,
  `%APPDATA%\Claude Usage Dashboard\config.json`. Easiest way to change
  calibration is the tray **"Calibrate…"** button; the tray **"Open config
  folder"** item opens the file directly for manual edits. (`npm run cal` only
  applies to the from-source install.)

Keys:

```json
{
  "metric": "cost",
  "fableWeeklyLimit": 1596.84,
  "weeklyLimit": 3360.24,
  "sessionLimit": 191.48,
  "weeklyResetDay": 1,
  "weeklyResetHour": 9,
  "opacity": 1.0
}
```

- The three `*Limit` values are in the metric's unit (cost `$` by default). All
  optional — only the one you calibrate shows "remaining"; the rest show an
  informational "used" bar.
- `weeklyResetDay` (0=Sun…6=Sat) / `weeklyResetHour` anchor the weekly window;
  default Mon 09:00 to match `/usage`'s "Resets Mon 9:00 AM". Change if your plan
  resets at a different time.
- Set `"metric": "tokens"` to revert to raw-token counting (less accurate).

### Two known systematic gaps

1. **This machine only.** Weekly limits are account-wide, but the widget only
   scans this machine's `~/.claude/projects`. Usage from claude.ai or other
   devices is invisible → it can read low. (Same caveat as `/usage`'s
   "this machine only, excludes claude.ai".)
2. **Approximate weighting.** Cost-weighting is the best local approximation, not
   Anthropic's exact formula, so it can drift a few points when your workload mix
   changes a lot. Re-run `npm run cal` when it looks off.

## Regenerating the icon

The tray/app icon is generated programmatically. Needs Python + Pillow
(`pip install pillow`):

```bash
python make_icon.py   # writes assets/icon-*.png and assets/icon.ico
```

## Auto-start on login (Windows, optional)

Run from the project directory:

```powershell
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ClaudeUsageDashboard.lnk")
$sc.TargetPath  = "$env:ComSpec"
$sc.Arguments   = "/c cd /d `"$PWD`" && npm start"
$sc.WindowStyle = 7
$sc.Save()
```

## License

MIT — see [LICENSE](LICENSE).
