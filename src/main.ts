#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getOrCreateRunner, type AgentRunner } from "./agent.js";
import { DiscordBot, type DiscordEvent, type DiscordHandler } from "./discord.js";
import * as log from "./log.js";
import { ChannelStore } from "./store.js";

const token = process.env.DISCORD_TOKEN;
const configuredWorkingDir = process.argv[2] ?? process.env.PI_DISCORD_BOT_WORKDIR;
const defaultWorkingDir = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi-discord-bot", "agent");
const workingDir = resolve(configuredWorkingDir ?? defaultWorkingDir);

if (!token) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

const rootDir = workingDir;

interface ConversationState {
  running: boolean;
  runner: AgentRunner;
  stopRequested: boolean;
}

const states = new Map<string, ConversationState>();

function getConversationKey(event: DiscordEvent): string {
  if (event.threadId && event.guildId) return `guild:${event.guildId}:thread:${event.threadId}`;
  if (event.guildId) return `guild:${event.guildId}:channel:${event.channelId}`;
  return `dm:${event.userId}`;
}

function getState(event: DiscordEvent): ConversationState {
  const key = getConversationKey(event);
  let state = states.get(key);
  if (!state) {
    state = {
      running: false,
      runner: getOrCreateRunner(rootDir, key),
      stopRequested: false,
    };
    states.set(key, state);
  }
  return state;
}

let bot!: DiscordBot;

function helpText(): string {
  return [
    "Commands:",
    "- /new",
    "- /name <name>",
    "- /session",
    "- /tree",
    "- /tree <entryId>",
    "- /model",
    "- /model <provider/model-or-search>",
    "- /scoped-models",
    "- /scoped-models <pattern[,pattern...]>",
    "- /settings",
    "- /compact [instructions]",
    "- /reload",
    "- /login [provider]",
    "- /logout [provider]",
    "- /stop",
    "Unsupported in Discord: /resume, /fork, /copy, /export, /share, /hotkeys, /changelog, /quit, /exit",
  ].join("\n");
}

function isUiCommand(command: string): boolean {
  return new Set([
    "/help",
    "/new",
    "/name",
    "/session",
    "/model",
    "/scoped-models",
    "/settings",
    "/compact",
    "/reload",
    "/login",
    "/logout",
    "/resume",
    "/tree",
    "/fork",
    "/copy",
    "/export",
    "/share",
    "/hotkeys",
    "/changelog",
    "/quit",
    "/exit",
  ]).has(command);
}

function isImmediateCommand(command: string): boolean {
  return new Set([
    "/help",
    "/session",
    "/tree",
    "/model",
    "/settings",
  ]).has(command);
}

async function handleCommand(event: DiscordEvent, transport: DiscordBot): Promise<boolean> {
  const text = event.text.trim();
  if (!text.startsWith("/")) return false;

  const ctx = await transport.createContext(event);
  const state = getState(event);
  const [command, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  if (event.source === "slash" && isUiCommand(command)) {
    await ctx.setWorking(false);
  }

  if (state.running && command !== "/stop" && !isImmediateCommand(command)) {
    await ctx.replaceMessage("Already working. Use /stop first, then retry your command.");
    return true;
  }

  switch (command) {
    case "/help":
      await ctx.replaceMessage(helpText());
      return true;
    case "/new":
      await state.runner.newSession();
      await ctx.replaceMessage(`Started a new session. Current model: ${state.runner.currentModel()}`);
      return true;
    case "/name":
      if (!args) {
        await ctx.replaceMessage("Usage: /name <name>");
        return true;
      }
      state.runner.renameSession(args);
      await ctx.replaceMessage(`Session name set to: ${args}`);
      return true;
    case "/session":
      await transport.showSessionCard(event, state.runner.getSessionCardData());
      return true;
    case "/tree":
      if (!args) {
        const browser = state.runner.getTreeBrowserData();
        if (browser.entries.length === 0) {
          await ctx.replaceMessage("Session tree is empty.");
          return true;
        }
        let page = 0;
        while (true) {
          const selected = await transport.promptTreeSelection(event, { ...browser, page });
          if (!selected || selected === "close") {
            return true;
          }
          if (selected === "prev") {
            page = Math.max(0, page - 1);
            continue;
          }
          if (selected === "next") {
            page += 1;
            continue;
          }
          await ctx.replaceMessage(await state.runner.navigateTree(selected));
          return true;
        }
      }
      await ctx.replaceMessage(await state.runner.navigateTree(args));
      return true;
    case "/model":
      if (!args) {
        let current = state.runner.currentModel();
        const models = state.runner.listModels().split("\n").map((line) => line.replace(/^[*-]\s+/, "")).filter(Boolean);
        let page = 0;
        while (true) {
          const selected = await transport.promptModelSelection(event, {
            currentModel: current,
            models,
            title: "Select model",
            page,
          });
          if (!selected) {
            await ctx.replaceMessage(`Current model: ${current}`);
            return true;
          }
          if (selected === "prev") {
            page = Math.max(0, page - 1);
            continue;
          }
          if (selected === "next") {
            page += 1;
            continue;
          }
          if (selected === "close") {
            await ctx.replaceMessage(`Current model: ${current}`);
            return true;
          }
          try {
            current = await state.runner.setModel(selected);
            await ctx.replaceMessage(`Model set to ${current}`);
            return true;
          } catch (err) {
            await ctx.replaceMessage(err instanceof Error ? err.message : String(err));
            return true;
          }
        }
      }
      try {
        const selected = await state.runner.setModel(args);
        await ctx.replaceMessage(`Model set to ${selected}`);
      } catch (err) {
        await ctx.replaceMessage(err instanceof Error ? err.message : String(err));
      }
      return true;
    case "/scoped-models":
      if (!args) {
        const available = state.runner.listModels().split("\n").map((line) => line.replace(/^[*-]\s+/, "")).filter(Boolean);
        const current = state.runner.getScopedModels().split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
        let page = 0;
        while (true) {
          const selected = await transport.promptScopedModelSelection(event, { currentModels: current, models: available, page });
          if (selected === null || selected === "close") {
            await ctx.replaceMessage(state.runner.getScopedModels());
            return true;
          }
          if (selected === "prev") {
            page = Math.max(0, page - 1);
            continue;
          }
          if (selected === "next") {
            page += 1;
            continue;
          }
          await ctx.replaceMessage(selected.length > 0 ? state.runner.setScopedModels(selected.join(",")) : state.runner.clearScopedModels());
          return true;
        }
      }
      if (args === "clear") {
        await ctx.replaceMessage(state.runner.clearScopedModels());
        return true;
      }
      await ctx.replaceMessage(state.runner.setScopedModels(args));
      return true;
    case "/settings": {
      let summary = state.runner.getSettingsSummary();
      while (true) {
        const action = await transport.promptSettingsCard(event, summary);
        if (!action || action === "done") {
          await ctx.replaceMessage(summary);
          return true;
        }
        summary = action === "thinking"
          ? state.runner.cycleThinkingSetting()
          : action === "transport"
            ? state.runner.cycleTransportSetting()
            : action === "steering"
              ? state.runner.toggleSteeringModeSetting()
              : action === "followup"
                ? state.runner.toggleFollowUpModeSetting()
                : state.runner.toggleAutoCompactSetting();
      }
    }
    case "/compact": {
      const approved = await transport.requestApproval(event, {
        title: "Approve compaction",
        description: args ? `Compact this session with custom instructions:\n\n${args}` : "Compact this session now?",
        approveLabel: "Compact",
        bullets: [
          "Summarizes older conversation history",
          "Keeps recent context and session continuity",
          "May lose some fine-grained older details",
        ],
        caution: "Compaction is lossy. Full history remains in the session file, but active context becomes summarized.",
      });
      if (!approved) {
        await ctx.replaceMessage("Compaction cancelled.");
        return true;
      }
      await ctx.replaceMessage(await state.runner.compact(args || undefined));
      return true;
    }
    case "/reload": {
      const approved = await transport.requestApproval(event, {
        title: "Approve reload",
        description: "Reload settings, skills, prompts, extensions, and model registry?",
        approveLabel: "Reload",
        bullets: [
          "Refreshes model registry and auth-backed availability",
          "Reloads skills, prompts, and extensions",
          "Applies updated configuration for future turns",
        ],
        caution: "Reload affects future turns. It does not rewrite past messages.",
      });
      if (!approved) {
        await ctx.replaceMessage("Reload cancelled.");
        return true;
      }
      await ctx.replaceMessage(await state.runner.reload());
      return true;
    }
    case "/login":
      await ctx.replaceMessage(args
        ? `This Discord harness uses Pi's shared auth. Complete login locally with:\npi\n/login ${args}`
        : "This Discord harness uses Pi's shared auth. Complete login locally with:\npi\n/login");
      return true;
    case "/logout":
      await ctx.replaceMessage(args
        ? `Log out locally with:\npi\n/logout ${args}`
        : "Log out locally with:\npi\n/logout");
      return true;
    case "/stop":
      await state.runner.abort();
      await ctx.replaceMessage("Stop requested.");
      return true;
    case "/resume":
    case "/fork":
    case "/copy":
    case "/export":
    case "/share":
    case "/hotkeys":
    case "/changelog":
    case "/quit":
    case "/exit":
      await ctx.replaceMessage(`${command} is a Pi TUI command that is not supported in this Discord harness.`);
      return true;
    default:
      await ctx.replaceMessage(`Unknown command.\n\n${helpText()}`);
      return true;
  }
}

const handler: DiscordHandler = {
  isRunning(conversationKey: string): boolean {
    return states.get(conversationKey)?.running ?? false;
  },
  async handleStop(conversationKey: string): Promise<void> {
    const state = states.get(conversationKey);
    if (!state?.running) return;
    state.stopRequested = true;
    state.runner.abort();
  },
  async handleEvent(event: DiscordEvent, transport: DiscordBot): Promise<void> {
    if (await handleCommand(event, transport)) return;

    const key = getConversationKey(event);
    const state = getState(event);
    if (state.running) {
      const channel = await transport.createContext(event);
      await channel.respond("Already working. Say `stop` to cancel.");
      return;
    }

    state.running = true;
    state.stopRequested = false;
    log.info(`[${key}] starting run: ${event.text.slice(0, 80)}`);
    try {
      const ctx = await transport.createContext(event);
      const result = await state.runner.run(ctx);
      if (result.stopReason === "aborted" && state.stopRequested) {
        await ctx.respondInThread("Stopped.");
      } else if (result.stopReason === "error" && result.errorMessage) {
        await ctx.respondInThread(`Error: ${result.errorMessage}`);
      }
    } catch (err) {
      log.error(`[${key}] run failed`, err);
    } finally {
      state.running = false;
    }
  },
};

const store = new ChannelStore(rootDir);
bot = new DiscordBot(token, handler, store, rootDir);

process.on("SIGINT", () => {
  log.info("Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log.info("Shutting down...");
  process.exit(0);
});

await bot.start();
