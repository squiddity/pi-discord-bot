import type { ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction } from "discord.js";
import type { DiscordEvent } from "./discord-types.js";
import * as log from "./log.js";

function clearByPrefix<T>(registry: Map<string, T>, prefix: string): void {
  for (const key of registry.keys()) {
    if (key.startsWith(prefix)) registry.delete(key);
  }
}

export interface PendingInteractionState {
  pendingSlashInteractions: Map<string, ChatInputCommandInteraction>;
  pendingModelSelections: Map<string, { userId: string; resolve: (value: string | null) => void }>;
  pendingModelPages: Map<string, { userId: string; resolve: (value: "prev" | "next" | "close") => void }>;
  pendingScopedSelections: Map<string, { userId: string; resolve: (value: string[] | null) => void }>;
  pendingScopedPages: Map<string, { userId: string; resolve: (value: "prev" | "next" | "close") => void }>;
  pendingApprovals: Map<string, { userId: string; resolve: (value: boolean) => void }>;
  pendingSettingsActions: Map<string, { userId: string; resolve: (value: "thinking" | "transport" | "steering" | "followup" | "compact" | "done" | null) => void }>;
  pendingTreeSelections: Map<string, { userId: string; resolve: (value: string | null) => void }>;
  pendingTreePages: Map<string, { userId: string; resolve: (value: "prev" | "next" | "close") => void }>;
}

async function rejectForeignInteraction(interaction: StringSelectMenuInteraction | ButtonInteraction, message: string): Promise<boolean> {
  await interaction.reply({ content: message, ephemeral: true });
  return true;
}

export async function handleSelectMenuInteraction(interaction: StringSelectMenuInteraction, state: PendingInteractionState): Promise<boolean> {
  const modelRequest = state.pendingModelSelections.get(interaction.customId);
  if (modelRequest) {
    if (interaction.user.id !== modelRequest.userId) return rejectForeignInteraction(interaction, "This selector belongs to another user.");
    state.pendingModelSelections.delete(interaction.customId);
    clearByPrefix(state.pendingModelPages, interaction.customId.replace(/:select$/, ":"));
    await interaction.update({ content: `Selected model: ${interaction.values[0]}`, embeds: [], components: [] });
    modelRequest.resolve(interaction.values[0] ?? null);
    return true;
  }

  const scopedRequest = state.pendingScopedSelections.get(interaction.customId);
  if (scopedRequest) {
    if (interaction.user.id !== scopedRequest.userId) return rejectForeignInteraction(interaction, "This selector belongs to another user.");
    state.pendingScopedSelections.delete(interaction.customId);
    clearByPrefix(state.pendingScopedPages, interaction.customId.replace(/:select$/, ":"));
    await interaction.update({ content: interaction.values.length > 0 ? `Scoped models updated (${interaction.values.length} selected).` : "Scoped models cleared.", embeds: [], components: [] });
    scopedRequest.resolve(interaction.values);
    return true;
  }

  const treeRequest = state.pendingTreeSelections.get(interaction.customId);
  if (treeRequest) {
    if (interaction.user.id !== treeRequest.userId) return rejectForeignInteraction(interaction, "This tree browser belongs to another user.");
    state.pendingTreeSelections.delete(interaction.customId);
    clearByPrefix(state.pendingTreePages, interaction.customId.replace(/:select$/, ":"));
    await interaction.update({ content: `Navigating to ${interaction.values[0]}...`, embeds: [], components: [] });
    log.info(`tree navigate selected by ${interaction.user.username}: ${interaction.values[0]}`);
    treeRequest.resolve(interaction.values[0] ?? null);
    return true;
  }

  return false;
}

export async function handleButtonInteraction(interaction: ButtonInteraction, state: PendingInteractionState): Promise<boolean> {
  const pageAction = state.pendingModelPages.get(interaction.customId);
  if (pageAction) {
    if (interaction.user.id !== pageAction.userId) return rejectForeignInteraction(interaction, "This selector belongs to another user.");
    state.pendingModelPages.delete(interaction.customId);
    await interaction.update({ content: interaction.customId.endsWith(":close") ? "Closed." : "Loading models...", embeds: [], components: [] });
    pageAction.resolve(interaction.customId.endsWith(":prev") ? "prev" : interaction.customId.endsWith(":next") ? "next" : "close");
    return true;
  }

  const scopedPageAction = state.pendingScopedPages.get(interaction.customId);
  if (scopedPageAction) {
    if (interaction.user.id !== scopedPageAction.userId) return rejectForeignInteraction(interaction, "This selector belongs to another user.");
    state.pendingScopedPages.delete(interaction.customId);
    await interaction.update({ content: interaction.customId.endsWith(":close") ? "Closed." : "Loading scoped models...", embeds: [], components: [] });
    scopedPageAction.resolve(interaction.customId.endsWith(":prev") ? "prev" : interaction.customId.endsWith(":next") ? "next" : "close");
    return true;
  }

  const settingsAction = state.pendingSettingsActions.get(interaction.customId);
  if (settingsAction) {
    if (interaction.user.id !== settingsAction.userId) return rejectForeignInteraction(interaction, "This settings card belongs to another user.");
    state.pendingSettingsActions.delete(interaction.customId);
    const action = interaction.customId.split(":").pop() as "thinking" | "transport" | "steering" | "followup" | "compact" | "done";
    await interaction.update({ content: action === "done" ? "Done." : `Applying settings action: ${action}`, embeds: [], components: [] });
    settingsAction.resolve(action);
    return true;
  }

  const treePageAction = state.pendingTreePages.get(interaction.customId);
  if (treePageAction) {
    if (interaction.user.id !== treePageAction.userId) return rejectForeignInteraction(interaction, "This tree browser belongs to another user.");
    state.pendingTreePages.delete(interaction.customId);
    await interaction.update({ content: interaction.customId.endsWith(":close") ? "Closed." : "Loading session tree...", embeds: [], components: [] });
    treePageAction.resolve(interaction.customId.endsWith(":prev") ? "prev" : interaction.customId.endsWith(":next") ? "next" : "close");
    return true;
  }

  const approval = state.pendingApprovals.get(interaction.customId);
  if (approval) {
    if (interaction.user.id !== approval.userId) return rejectForeignInteraction(interaction, "This approval belongs to another user.");
    const baseId = interaction.customId.replace(/:(approve|reject)$/, "");
    state.pendingApprovals.delete(`${baseId}:approve`);
    state.pendingApprovals.delete(`${baseId}:reject`);
    const approved = interaction.customId.endsWith(":approve");
    await interaction.update({ content: approved ? "Approved." : "Cancelled.", embeds: [], components: [] });
    log.info(`approval ${approved ? "approved" : "cancelled"} by ${interaction.user.username}`);
    approval.resolve(approved);
    return true;
  }

  return false;
}

export function slashCommandToText(interaction: ChatInputCommandInteraction): string | null {
  if (interaction.commandName === "pi") return interaction.options.getString("prompt", true).trim();
  if (interaction.commandName === "new") return "/new";
  if (interaction.commandName === "name") return `/name ${interaction.options.getString("name", true).trim()}`;
  if (interaction.commandName === "session") return "/session";
  if (interaction.commandName === "tree") {
    const entryId = interaction.options.getString("entry_id")?.trim();
    return entryId ? `/tree ${entryId}` : "/tree";
  }
  if (interaction.commandName === "model") {
    const reference = interaction.options.getString("reference")?.trim();
    return reference ? `/model ${reference}` : "/model";
  }
  if (interaction.commandName === "scoped-models") {
    const patterns = interaction.options.getString("patterns")?.trim();
    return patterns ? `/scoped-models ${patterns}` : "/scoped-models";
  }
  if (interaction.commandName === "settings") return "/settings";
  if (interaction.commandName === "compact") {
    const instructions = interaction.options.getString("instructions")?.trim();
    return instructions ? `/compact ${instructions}` : "/compact";
  }
  if (interaction.commandName === "reload") return "/reload";
  if (interaction.commandName === "login") {
    const provider = interaction.options.getString("provider")?.trim();
    return provider ? `/login ${provider}` : "/login";
  }
  if (interaction.commandName === "logout") {
    const provider = interaction.options.getString("provider")?.trim();
    return provider ? `/logout ${provider}` : "/logout";
  }
  return null;
}

export function buildSlashEvent(interaction: ChatInputCommandInteraction, text: string): DiscordEvent {
  return {
    type: "slash",
    source: "slash",
    channelId: interaction.channelId,
    guildId: interaction.guildId ?? undefined,
    threadId: interaction.channel?.isThread() ? interaction.channel.id : undefined,
    messageId: interaction.id,
    userId: interaction.user.id,
    userName: interaction.user.username,
    text,
    attachments: [],
  };
}
