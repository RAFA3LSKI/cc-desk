<p align="center"><img src="cc-desk.png" width="128" alt="CC Desk icon"></p>

# CC Desk

A small macOS window for [Claude Code](https://docs.claude.com/en/docs/claude-code) that feels like a chat app: your sessions in a sidebar, the **real `claude` terminal** on the right.

> Unofficial. Not made by, affiliated with, or endorsed by Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks.

It doesn't replace or modify Claude Code. It runs your installed `claude` in an embedded terminal, so your settings, hooks, skills, plugins and MCP servers all work exactly as they do in Terminal.

## What you get
- **Sessions sidebar**: every past session under its real title, search, pins, rename (shows in `/resume` too), click to resume
- **Several sessions open at once**, with live dots: working · waiting for you · finished
- **Mac notifications** when a session finishes or needs you; click to jump there
- **Settings window** (⌘,) for model, effort, permissions, theme, notifications, plugins, connections (`claude mcp list`)
- **Sessions that survive quitting:** a small background helper holds them, so quit or update the app and they keep working, then reconnect when you reopen it. You choose in Settings whether quitting asks first. Sessions untouched for 24 hours stop on their own; their chats stay saved.
- **Split view:** see up to 3 sessions at once: side by side, stacked, or two beside each other with one across the top or bottom.
- **Phone alerts (optional):** when Claude has waited over 90 seconds for an answer or permission, even with the app closed, using the free ntfy app.
- **Usage page** in Settings: estimated cost, input, output and cached tokens by session, day, hour and model.
- **Per-session usage** (turns and tokens), a ⟲ Rewind button, drag files onto a session, an account menu
- **Updates in the app**: an "Update available" line shows up when there's a new version

## Install
Needs macOS, [Node.js](https://nodejs.org) 20+, Claude Code (logged in) and Apple's command line tools (`xcode-select --install`).

```bash
git clone https://github.com/RAFA3LSKI/cc-desk.git ~/cc-desk
cd ~/cc-desk && ./install.sh
```
Then open **CC Desk** from Spotlight (⌘ Space). Updates: click **Install & restart** when the app offers one, or run `./install.sh --update`.

## Privacy
Everything stays on your Mac. CC Desk sends nothing anywhere: no analytics, no server. It reads Claude Code's local files (`~/.claude/projects`, `~/.claude/sessions`), and it writes only:
- the rename line that Claude Code's own `/rename` writes,
- the settings you change in its Settings window, in `~/.claude/settings.json` (backed up first; every other key is left alone),
- its own preferences, in `~/.claude-desk.json`,
- a cache of token counts for the Usage page, in `~/.claude-desk-usage.json`,
- the background helper's socket and log, `~/.claude-desk-ptyd.sock` and `.log`.

The only network traffic is `git fetch` against this repo, to check for updates, and, only if you turn on phone alerts, a short message ("Claude needs you" plus the session name) sent through the public [ntfy.sh](https://ntfy.sh) server to your private random channel. Installing an update runs the new version's code on your Mac (like any app update), so only install updates from this repo.

## How it works
Electron + [xterm.js](https://xtermjs.org) + [node-pty](https://github.com/microsoft/node-pty). `sessions.js` reads the session files, `settings.js` edits a whitelist of settings, `main.js` runs `claude` in a pseudo-terminal, `index.html` is the UI. Live status comes from the `~/.claude/sessions/<pid>.json` files Claude Code writes (an approach borrowed from [Nimbalyst](https://github.com/nimbalyst/nimbalyst)).

Checks: `node check.js` (session parsing) · `DESK_SMOKE=1 ~/Applications/"CC Desk.app"/Contents/MacOS/Electron` (hidden UI load).

## License
MIT
