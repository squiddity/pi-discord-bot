# pi-discord-bot

A Discord bot for [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that lets you use your Pi agent in DMs and servers.

It keeps Pi as the agent core and adds a Discord transport layer with:
- one runner per conversation
- append-only session/log files
- Discord-native embeds, buttons, and select menus
- approval-gated Discord admin actions
- systemd-friendly local operation

## Quick start

1. Install Pi: [Pi quick start guide](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start)
2. Install this package:

```bash
pi install npm:pi-discord-bot
```

3. Start Pi and ask it to guide setup:

```text
/skill:pi-discord-bot help me set up the bot
```

## What users can do

In DMs:
- `help me debug this error`
- `summarize this file`
- `write a Python script for me`

In servers:
- `@your-bot help me build a React component`
- `@your-bot explain this stack trace`

Text commands:
- `/help`
- `/session`
- `/tree`
- `/model`
- `/settings`
- `/stop`

## Why use this

- Uses Pi's shared auth, settings, models, skills, and extensions
- Keeps Discord as a transport layer instead of reimplementing an agent
- Supports both chat-style prompting and command-style interaction
- Works locally and with systemd

## Architecture

This project does **not** reimplement Pi’s core agent loop.
It uses:
- `@mariozechner/pi-agent-core` `Agent`
- `@mariozechner/pi-coding-agent` `AgentSession`
- `SessionManager`
- `SettingsManager`
- `AuthStorage`
- `ModelRegistry`

Main files:
- `src/main.ts` — startup and command routing
- `src/discord.ts` — Discord transport and interaction handling
- `src/discord-ui.ts` — embed/card builders and Discord UI helpers
- `src/agent.ts` — Pi runner/session wiring
- `src/agent-models.ts` — model resolution helpers
- `src/agent-tree.ts` — session tree formatting/browser helpers
- `src/context.ts` — sync `log.jsonl` into Pi session state
- `src/store.ts` — log + attachment persistence

## Features

- DM support
- guild support with mention gating for normal chat
- text commands like `/tree` in chat
- Discord slash commands
- model picker cards
- scoped model selector cards
- settings card
- session tree browser card
- approval cards for destructive / mutating actions
- detail threads in guilds for verbose output
- reactions for progress:
  - `🤔` thinking/working
  - `🧑‍💻` tool activity
- long-message chunking
- image attachment support
- file attachment download + local-path handoff to Pi tools

## Commands

Supported command surface:
- `/help`
- `/new`
- `/name <name>`
- `/session`
- `/tree`
- `/tree <entryId>`
- `/model`
- `/model <provider/model-or-search>`
- `/scoped-models`
- `/scoped-models <pattern[,pattern...]>`
- `/scoped-models clear`
- `/settings`
- `/compact [instructions]`
- `/reload`
- `/login [provider]`
- `/logout [provider]`
- `/stop`

Unsupported in Discord:
- `/resume`
- `/fork`
- `/copy`
- `/export`
- `/share`
- `/hotkeys`
- `/changelog`
- `/quit`
- `/exit`

## Install

### Use as a Pi package skill

1. **Install Pi** — follow the [Pi quick start guide](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#quick-start) and configure your provider auth (e.g. `pi login`).

2. **Install this package** — run in your terminal:

```bash
pi install npm:pi-discord-bot
```

3. **Start Pi and ask your agent** — just run `pi` and ask it to help you set up the Discord bot:

```text
/skill:pi-discord-bot help me set up the bot
```

The Pi agent will walk you through creating your Discord app, configuring the token, setting up the policy file, and starting the bot. You don't need to memorize any setup steps — just ask.

Alternatively, from a local source checkout:

```bash
pi install /absolute/path/to/pi-discord-bot
```

See also:
- `docs/using-skill-in-pi.md`

### Develop or run from source

```bash
npm install
```

## Run locally

By default, the runtime workspace is **outside the repo**:

```text
$XDG_STATE_HOME/pi-discord-bot/agent
```

or, if `XDG_STATE_HOME` is unset:

```text
~/.local/state/pi-discord-bot/agent
```

Run with the default external workspace:

```bash
export DISCORD_TOKEN=...
npx tsx src/main.ts
```

Or override it explicitly:

```bash
PI_DISCORD_BOT_WORKDIR=/absolute/path/to/pi-discord-bot-agent npx tsx src/main.ts
```

Or:

```bash
npm run build
npm start
```

## Auth and model selection

Do **not** hardcode model choices in the bot.
This project uses Pi shared auth/settings/default model flow.

The bot reads model availability from Pi’s model registry and lets you choose with Discord UI.

## Discord setup

Create a Discord application and bot, then enable:
- **Message Content Intent**

Recommended scopes:
- `bot`
- `applications.commands`

Recommended bot permissions:
- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Create Private Threads
- Read Message History
- Attach Files
- Use Slash Commands
- Manage Channels
  - needed if you want channel/category/thread admin tools to work

## Policy file

Create the runtime policy file in the external workspace:

```bash
mkdir -p ~/.local/state/pi-discord-bot/agent
cp discord-policy.example.json ~/.local/state/pi-discord-bot/agent/discord-policy.json
```

Or, if using a custom workspace path:

```bash
mkdir -p "$PI_DISCORD_BOT_WORKDIR"
cp discord-policy.example.json "$PI_DISCORD_BOT_WORKDIR/discord-policy.json"
```

Example:

```json
{
  "allowDMs": true,
  "guildIds": ["123456789012345678"],
  "channelIds": ["234567890123456789"],
  "mentionMode": "mention-only",
  "slashCommands": {
    "enabled": true
  }
}
```

Notes:
- omit `guildIds` to allow all guilds
- omit `channelIds` to allow all channels
- `mentionMode: "mention-only"` means normal non-command guild chat must mention the bot
- text commands beginning with `/` are accepted without mentioning the bot
- slash commands can be registered globally or to a guild via policy/env

## Attachments

Normal Discord message attachments are handled like this:
- images (`png`, `jpg`, `jpeg`, `gif`, `webp`) are passed to Pi as image input
- other files are downloaded into the conversation `attachments/` directory and their local paths are added to the prompt so Pi tools can inspect them

Slash-command attachments are not currently wired.

## Runtime layout

Default runtime root:

```text
~/.local/state/pi-discord-bot/agent/
```

Layout:

```text
agent/
  discord-policy.json
  MEMORY.md
  skills/
  guild:123:channel:456/
    MEMORY.md
    log.jsonl
    context.jsonl
    attachments/
    scratch/
    skills/
  dm:999/
    ...
```

## Operator env/config guide

For operator-focused configuration, especially if you already use Pi CLI / TUI on the same machine, see:

- `docs/operator-env-config.md`
- `docs/using-skill-in-pi.md`
- `docs/publishing-checklist.md`
- `docs/github-release-flow.md`

Those guides explain:
- how to install the package into Pi from npm or source
- how to use `/skill:pi-discord-bot`
- `~/.config/pi-discord-bot.env`
- Pi shared auth/settings expectations
- workspace `discord-policy.json`
- systemd usage
- troubleshooting for operators

## systemd

A user service file is included:
- `pi-discord-bot.service`

Typical setup:

```bash
mkdir -p ~/.config/systemd/user ~/.config
cp pi-discord-bot.service ~/.config/systemd/user/
cp pi-discord-bot.env.example ~/.config/pi-discord-bot.env
$EDITOR ~/.config/pi-discord-bot.env
systemctl --user daemon-reload
systemctl --user enable --now pi-discord-bot.service
```

Useful commands:

```bash
systemctl --user status pi-discord-bot.service
journalctl --user -u pi-discord-bot.service -f
systemctl --user restart pi-discord-bot.service
```

## Troubleshooting

### Slash command updated in code but not in Discord
If you register commands globally, Discord may take time to refresh the slash-command UI.
The bot may already support the command even if the Discord slash menu has not updated yet.

What you can do:
- wait for Discord to refresh global commands
- reopen/refresh the Discord client
- use a text command like `/tree` directly in chat while waiting

### Text command vs slash command
There are two ways to invoke commands:
- **slash command UI**: `/tree`, `/model`, etc. from Discord command picker
- **plain text command message**: a normal message beginning with `/`

In guilds:
- normal non-command chat still follows mention gating
- plain text commands beginning with `/` are accepted without mentioning the bot

### Attachments
Current attachment behavior:
- normal message image attachments are passed as image input
- normal message non-image files are downloaded and exposed as local files for Pi tools
- slash-command attachments are **not** currently supported

### Admin tools do not work
Make sure the bot has the required Discord permissions for the action.
For server structure mutations, you usually need:
- View Channels
- Send Messages
- Read Message History
- Use Slash Commands
- Manage Channels
- Create Public Threads
- Create Private Threads

## Debugging notes
The bot logs useful runtime events through the service log, including:
- startup and slash command registration
- skipped messages due to policy
- backfill activity
- queue/update warnings

Use:

```bash
journalctl --user -u pi-discord-bot.service -f
```

## Security / hygiene

Runtime conversation data is stored under the external workspace directory (by default `~/.local/state/pi-discord-bot/agent/`) and may contain:
- user messages
- assistant outputs
- attachment metadata
- local file paths
- tool results

Treat the workspace directory as private runtime state.
Do not commit or share it.

The repo includes a `.gitignore` that excludes runtime state and build artifacts.
