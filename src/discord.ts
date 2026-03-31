import {
  Client,
  GatewayIntentBits,
  Message,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from "discord.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TreeBrowserData } from "./agent-tree.js";
import { createDiscordContext } from "./discord-context.js";
import {
  buildSlashEvent,
  handleButtonInteraction,
  handleSelectMenuInteraction,
  slashCommandToText,
  type PendingInteractionState,
} from "./discord-interactions.js";
import { buildSlashCommands, isAllowedDiscordMessage, loadDiscordPolicy } from "./discord-policy.js";
import type { DiscordContext, DiscordEvent, DiscordHandler, DiscordPolicy, LoggedMessage } from "./discord-types.js";
import * as log from "./log.js";
import { ChannelStore, type StoredAttachment } from "./store.js";
import {
  buildApprovalCard,
  buildModelSelectionCard,
  buildScopedModelSelectionCard,
  buildSessionCard,
  buildSettingsCard,
  buildTreeSelectionCard,
} from "./discord-ui.js";
import { clearPending, registerManyPending, registerPending, resolveOnTimeout } from "./discord-registry.js";

export type { DiscordContext, DiscordEvent, DiscordHandler } from "./discord-types.js";

function isImmediateCommandText(text: string): boolean {
  const command = text.trim().split(/\s+/)[0];
  return new Set(["/help", "/session", "/tree", "/model", "/settings"]).has(command);
}

class ChannelQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;

  enqueue(fn: () => Promise<void>): void {
    this.queue.push(fn);
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    const fn = this.queue.shift()!;
    try {
      await fn();
    } catch (err) {
      log.warn("queue error", err instanceof Error ? err.message : String(err));
    }
    this.processing = false;
    await this.processNext();
  }
}

export class DiscordBot {
  private readonly client: Client;
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly botUserIdPromise: Promise<string>;
  private readonly pendingSlashInteractions = new Map<string, ChatInputCommandInteraction>();
  private readonly pendingModelSelections = new Map<string, { userId: string; resolve: (value: string | null) => void }>();
  private readonly pendingModelPages = new Map<string, { userId: string; resolve: (value: "prev" | "next" | "close") => void }>();
  private readonly pendingScopedSelections = new Map<string, { userId: string; resolve: (value: string[] | null) => void }>();
  private readonly pendingScopedPages = new Map<string, { userId: string; resolve: (value: "prev" | "next" | "close") => void }>();
  private readonly pendingApprovals = new Map<string, { userId: string; resolve: (value: boolean) => void }>();
  private readonly pendingSettingsActions = new Map<string, { userId: string; resolve: (value: "thinking" | "transport" | "steering" | "followup" | "compact" | "done" | null) => void }>();
  private readonly pendingTreeSelections = new Map<string, { userId: string; resolve: (value: string | null) => void }>();
  private readonly pendingTreePages = new Map<string, { userId: string; resolve: (value: "prev" | "next" | "close") => void }>();

  constructor(
    token: string,
    private readonly handler: DiscordHandler,
    private readonly store: ChannelStore,
    private readonly workingDir: string,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
    });

    this.botUserIdPromise = new Promise<string>((resolve) => {
      this.client.once("ready", () => resolve(this.client.user!.id));
    });

    this.client.on("messageCreate", (message) => {
      void this.onMessage(message);
    });
    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isChatInputCommand()) void this.onSlashCommand(interaction);
      else if (interaction.isStringSelectMenu()) void this.onSelectMenu(interaction);
      else if (interaction.isButton()) void this.onButton(interaction);
    });

    void this.client.login(token);
  }

  private get policyPath(): string {
    return join(this.workingDir, "discord-policy.json");
  }

  private loadPolicy(): DiscordPolicy {
    return loadDiscordPolicy(this.policyPath);
  }

  private get interactionState(): PendingInteractionState {
    return {
      pendingSlashInteractions: this.pendingSlashInteractions,
      pendingModelSelections: this.pendingModelSelections,
      pendingModelPages: this.pendingModelPages,
      pendingScopedSelections: this.pendingScopedSelections,
      pendingScopedPages: this.pendingScopedPages,
      pendingApprovals: this.pendingApprovals,
      pendingSettingsActions: this.pendingSettingsActions,
      pendingTreeSelections: this.pendingTreeSelections,
      pendingTreePages: this.pendingTreePages,
    };
  }

  private queueFor(key: string): ChannelQueue {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new ChannelQueue();
      this.queues.set(key, queue);
    }
    return queue;
  }

  async start(): Promise<void> {
    await this.botUserIdPromise;
    log.info(`connected to Discord as ${this.client.user?.tag ?? this.client.user?.id}`);
    await this.registerSlashCommands();
    await this.backfillKnownConversations();
  }

  private async registerSlashCommands(): Promise<void> {
    const policy = this.loadPolicy();
    if (policy.slashCommands?.enabled === false) return;
    if (!this.client.application) return;

    const commands = buildSlashCommands();
    const guildId = policy.slashCommands?.guildId;
    try {
      if (guildId) {
        await this.client.application.commands.set(commands, guildId);
        log.info(`registered slash commands in guild ${guildId}`);
      } else {
        await this.client.application.commands.set(commands);
        log.info("registered global slash commands");
      }
    } catch (err) {
      log.warn(
        "slash command registration failed (bot will continue without slash commands)",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const botUserId = await this.botUserIdPromise;
    const gate = isAllowedDiscordMessage(message, botUserId, this.loadPolicy());
    if (!gate.allowed) {
      log.info(`skipping message ${message.id}: ${gate.reason}`);
      return;
    }

    const conversationKey = this.getConversationKey(message);
    const isDm = message.channel.type === 1;
    const cleanedText = isDm ? message.content.trim() : message.content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();

    if (cleanedText.toLowerCase() === "stop") {
      if (this.handler.isRunning(conversationKey)) await this.handler.handleStop(conversationKey, this);
      else await this.postMessage(message.channel, "Nothing running.");
      return;
    }

    const attachments = await this.store.storeAttachments(conversationKey, message.attachments.values());
    this.store.appendLog(conversationKey, {
      date: new Date(message.createdTimestamp).toISOString(),
      messageId: message.id,
      channelId: message.channel.id,
      guildId: message.guildId ?? undefined,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
      authorId: message.author.id,
      authorName: message.author.username,
      text: cleanedText,
      attachments,
      isBot: false,
    });

    const event: DiscordEvent = {
      type: isDm ? "dm" : "mention",
      source: "message",
      channelId: message.channel.id,
      guildId: message.guildId ?? undefined,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
      messageId: message.id,
      userId: message.author.id,
      userName: message.author.username,
      text: cleanedText,
      attachments: attachments as StoredAttachment[],
    };

    if (isImmediateCommandText(cleanedText)) {
      void this.handler.handleEvent(event, this);
    } else {
      this.queueFor(conversationKey).enqueue(() => this.handler.handleEvent(event, this));
    }
  }

  private async onSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    await handleSelectMenuInteraction(interaction, this.interactionState);
  }

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    await handleButtonInteraction(interaction, this.interactionState);
  }

  private async onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const conversationKey = this.getConversationKeyFromIds(
      interaction.guildId ?? undefined,
      interaction.channelId,
      interaction.channel?.isThread() ? interaction.channel.id : undefined,
      interaction.user.id,
    );

    if (interaction.commandName === "stop") {
      await interaction.reply({ content: "Stopping current run if there is one...", ephemeral: true });
      await this.handler.handleStop(conversationKey, this);
      return;
    }

    const text = slashCommandToText(interaction);
    if (!text) return;

    log.info(`slash command ${interaction.commandName} from ${interaction.user.username} in ${conversationKey}`);
    await interaction.deferReply();
    this.pendingSlashInteractions.set(interaction.id, interaction);

    const event = buildSlashEvent(interaction, text);
    const key = this.getConversationKeyFromIds(event.guildId, event.channelId, event.threadId, event.userId);
    if (isImmediateCommandText(text)) {
      void this.handler.handleEvent(event, this);
    } else {
      this.queueFor(key).enqueue(() => this.handler.handleEvent(event, this));
    }
  }

  getConversationKey(message: Message): string {
    return this.getConversationKeyFromIds(message.guildId ?? undefined, message.channel.id, message.channel.isThread() ? message.channel.id : undefined, message.author.id);
  }

  private getConversationKeyFromIds(guildId: string | undefined, channelId: string, threadId: string | undefined, userId: string): string {
    if (threadId && guildId) return `guild:${guildId}:thread:${threadId}`;
    if (guildId) return `guild:${guildId}:channel:${channelId}`;
    return `dm:${userId}`;
  }

  private async getEventTarget(event: DiscordEvent): Promise<{ channel: TextBasedChannel; sendable: any; slashInteraction: ChatInputCommandInteraction | null }> {
    const channel = await this.client.channels.fetch(event.channelId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${event.channelId} is not text-based`);
    const slashInteraction = event.source === "slash" ? this.pendingSlashInteractions.get(event.messageId) ?? null : null;
    return { channel, sendable: channel as any, slashInteraction };
  }

  async promptModelSelection(event: DiscordEvent, params: { currentModel: string; models: string[]; title?: string; page?: number }): Promise<string | "prev" | "next" | "close" | null> {
    const { sendable, slashInteraction } = await this.getEventTarget(event);
    const card = buildModelSelectionCard({ ...params, messageId: event.messageId });
    if (slashInteraction) await slashInteraction.editReply({ content: "", embeds: [card.embed], components: card.rows });
    else await sendable.send({ embeds: [card.embed], components: card.rows });
    log.info(`opened model selector for ${event.userName}`);
    return await new Promise((resolve) => {
      registerPending({ registry: this.pendingModelSelections, key: card.ids.customId, userId: event.userId, resolve: (value) => resolve(value) });
      if (card.pageCount > 1) {
        registerManyPending({ registry: this.pendingModelPages, keys: [card.ids.prevId, card.ids.nextId, card.ids.closeId], userId: event.userId, resolve: (value) => resolve(value) });
      }
      resolveOnTimeout({ run: () => {
        log.info(`model selector timed out for ${event.userName}`);
        clearPending(this.pendingModelSelections, [card.ids.customId]);
        clearPending(this.pendingModelPages, [card.ids.prevId, card.ids.nextId, card.ids.closeId]);
        resolve(null);
        return true;
      } });
    });
  }

  async promptScopedModelSelection(event: DiscordEvent, params: { currentModels: string[]; models: string[]; page?: number }): Promise<string[] | "prev" | "next" | "close" | null> {
    const { sendable, slashInteraction } = await this.getEventTarget(event);
    const card = buildScopedModelSelectionCard({ ...params, messageId: event.messageId });
    if (slashInteraction) await slashInteraction.editReply({ content: "", embeds: [card.embed], components: card.rows });
    else await sendable.send({ embeds: [card.embed], components: card.rows });
    return await new Promise((resolve) => {
      registerPending({ registry: this.pendingScopedSelections, key: card.ids.customId, userId: event.userId, resolve: (value) => resolve(value) });
      if (card.pageCount > 1) {
        registerManyPending({ registry: this.pendingScopedPages, keys: [card.ids.prevId, card.ids.nextId, card.ids.closeId], userId: event.userId, resolve: (value) => resolve(value) });
      }
      resolveOnTimeout({ run: () => {
        clearPending(this.pendingScopedSelections, [card.ids.customId]);
        clearPending(this.pendingScopedPages, [card.ids.prevId, card.ids.nextId, card.ids.closeId]);
        resolve(null);
        return true;
      } });
    });
  }

  async showSessionCard(event: DiscordEvent, params: { title: string; fields: Array<{ name: string; value: string; inline?: boolean }> }): Promise<void> {
    const { sendable, slashInteraction } = await this.getEventTarget(event);
    const embed = buildSessionCard(params);
    if (slashInteraction) await slashInteraction.editReply({ content: "", embeds: [embed], components: [] });
    else await sendable.send({ embeds: [embed] });
  }

  async promptTreeSelection(event: DiscordEvent, params: TreeBrowserData & { page?: number }): Promise<string | "prev" | "next" | "close" | null> {
    const { sendable, slashInteraction } = await this.getEventTarget(event);
    const card = buildTreeSelectionCard({ ...params, messageId: event.messageId });
    if (slashInteraction) await slashInteraction.editReply({ content: "", embeds: [card.embed], components: card.rows });
    else await sendable.send({ embeds: [card.embed], components: card.rows });
    log.info(`opened tree browser for ${event.userName}`);
    return await new Promise((resolve) => {
      if (card.options.length > 0) registerPending({ registry: this.pendingTreeSelections, key: card.ids.customId, userId: event.userId, resolve: (value) => resolve(value) });
      registerManyPending({ registry: this.pendingTreePages, keys: [card.ids.prevId, card.ids.nextId, card.ids.closeId], userId: event.userId, resolve: (value) => resolve(value) });
      resolveOnTimeout({ run: () => {
        log.info(`tree browser timed out for ${event.userName}`);
        if (card.options.length > 0) clearPending(this.pendingTreeSelections, [card.ids.customId]);
        clearPending(this.pendingTreePages, [card.ids.prevId, card.ids.nextId, card.ids.closeId]);
        resolve(null);
        return true;
      } });
    });
  }

  async promptSettingsCard(event: DiscordEvent, summary: string): Promise<"thinking" | "transport" | "steering" | "followup" | "compact" | "done" | null> {
    const { sendable, slashInteraction } = await this.getEventTarget(event);
    const baseId = `settings:${event.messageId}:${Date.now()}`;
    const card = buildSettingsCard(summary, baseId);
    if (slashInteraction) await slashInteraction.editReply({ content: "", embeds: [card.embed], components: card.rows });
    else await sendable.send({ embeds: [card.embed], components: card.rows });
    return await new Promise((resolve) => {
      const keys = ["thinking", "transport", "steering", "followup", "compact", "done"].map((suffix) => `${baseId}:${suffix}`);
      registerManyPending({ registry: this.pendingSettingsActions, keys, userId: event.userId, resolve });
      resolveOnTimeout({ run: () => {
        if (clearPending(this.pendingSettingsActions, keys)) resolve(null);
        return true;
      } });
    });
  }

  async requestApproval(event: DiscordEvent, params: { title: string; description: string; approveLabel?: string; bullets?: string[]; caution?: string }): Promise<boolean> {
    const { sendable, slashInteraction } = await this.getEventTarget(event);
    const baseId = `approve:${event.messageId}:${Date.now()}`;
    const approveId = `${baseId}:approve`;
    const rejectId = `${baseId}:reject`;
    const card = buildApprovalCard({ ...params, approveId, rejectId });
    if (slashInteraction) await slashInteraction.editReply({ content: "", embeds: [card.embed], components: card.rows });
    else await sendable.send({ embeds: [card.embed], components: card.rows });
    log.info(`opened approval card for ${event.userName}: ${params.title}`);
    return await new Promise<boolean>((resolve) => {
      registerManyPending({ registry: this.pendingApprovals, keys: [approveId, rejectId], userId: event.userId, resolve });
      resolveOnTimeout({ run: () => {
        if (clearPending(this.pendingApprovals, [approveId, rejectId])) resolve(false);
        return true;
      } });
    });
  }

  async createContext(event: DiscordEvent): Promise<DiscordContext> {
    return createDiscordContext({
      client: this.client,
      store: this.store,
      event,
      pendingSlashInteractions: this.pendingSlashInteractions,
      getConversationKeyFromIds: (guildId, channelId, threadId, userId) => this.getConversationKeyFromIds(guildId, channelId, threadId, userId),
      requestApproval: (approvalEvent, approvalParams) => this.requestApproval(approvalEvent, approvalParams),
    });
  }

  async postMessage(channel: TextBasedChannel | string, text: string): Promise<string> {
    const resolved = typeof channel === "string" ? await this.client.channels.fetch(channel) : channel;
    if (!resolved?.isTextBased()) throw new Error("Channel is not text-based");
    const msg = await (resolved as any).send(text);
    return msg.id;
  }

  private async backfillKnownConversations(): Promise<void> {
    const entries = readdirSync(this.workingDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const entry of entries) {
      const key = entry.name;
      const logPath = join(this.workingDir, key, "log.jsonl");
      if (!existsSync(logPath)) continue;

      const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      if (lines.length === 0) continue;
      let last: LoggedMessage | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]) as LoggedMessage;
          if (parsed.channelId && parsed.messageId) {
            last = parsed;
            break;
          }
        } catch {}
      }
      if (!last?.channelId) continue;

      try {
        const channel = await this.client.channels.fetch(last.channelId);
        if (!channel?.isTextBased()) continue;
        const messages = await (channel as any).messages.fetch({ limit: 100, after: last.messageId });
        const sorted = [...messages.values()].sort((a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp);
        for (const message of sorted) {
          if (!message.author) continue;
          const attachments = message.author.bot ? [] : await this.store.storeAttachments(key, message.attachments.values());
          this.store.appendLog(key, {
            date: new Date(message.createdTimestamp).toISOString(),
            messageId: message.id,
            channelId: message.channel.id,
            guildId: message.guildId ?? undefined,
            threadId: message.channel.isThread() ? message.channel.id : undefined,
            authorId: message.author.id,
            authorName: message.author.username,
            text: message.author.bot ? message.content : message.content.trim(),
            attachments,
            isBot: message.author.bot,
          });
        }
        if (sorted.length > 0) log.info(`backfilled ${sorted.length} messages for ${key}`);
      } catch (err) {
        log.warn(`backfill failed for ${key}`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}
