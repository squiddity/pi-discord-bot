import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
  AgentSession,
  AuthStorage,
  convertToLlm,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { createDiscordSettingsManager } from "./context.js";
import { resolveInitialModel, formatModel } from "./agent-models.js";
import { buildAppendSystemPrompt, getMemory } from "./agent-prompt.js";
import { createDiscordCustomTools } from "./agent-tools.js";
import { createSessionOps } from "./agent-session-ops.js";
import { runAgentTurn, wireSessionUpdates } from "./agent-runner.js";
import type { AgentRunner, RunState } from "./agent-types.js";

export type { AgentRunner } from "./agent-types.js";

const runners = new Map<string, AgentRunner>();

export function getOrCreateRunner(workspaceDir: string, conversationKey: string): AgentRunner {
  const existing = runners.get(conversationKey);
  if (existing) return existing;
  const created = createRunner(workspaceDir, conversationKey);
  runners.set(conversationKey, created);
  return created;
}

function createRunner(workspaceDir: string, conversationKey: string): AgentRunner {
  const conversationDir = join(workspaceDir, conversationKey);
  const scratchDir = join(conversationDir, "scratch");
  const contextFile = join(conversationDir, "context.jsonl");
  const tools = createCodingTools(scratchDir);
  const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const sessionManager = SessionManager.open(contextFile, conversationDir);
  const settingsManager = createDiscordSettingsManager(workspaceDir);

  let appendSystemPrompt = buildAppendSystemPrompt(workspaceDir, conversationKey, getMemory(conversationDir));

  const resourceLoader = new DefaultResourceLoader({
    cwd: scratchDir,
    settingsManager,
    additionalSkillPaths: [
      join(workspaceDir, "skills"),
      join(conversationDir, "skills"),
    ],
    appendSystemPrompt,
  });

  const runState: RunState = {
    ctx: null,
    queue: Promise.resolve(),
    stopReason: "stop",
    errorMessage: undefined,
    pendingTools: new Map(),
  };

  const customTools = createDiscordCustomTools({ scratchDir, runState });
  const initialModel = resolveInitialModel(modelRegistry, settingsManager);

  let agent!: Agent;
  agent = new Agent({
    initialState: {
      systemPrompt: "",
      model: initialModel,
      thinkingLevel: settingsManager.getDefaultThinkingLevel() ?? "off",
      tools,
    },
    convertToLlm,
    getApiKey: async (): Promise<string> => {
      const currentModel = agent.state.model as Model<any> | undefined;
      const key = currentModel ? await modelRegistry.getApiKeyForProvider(currentModel.provider) : undefined;
      if (!key) throw new Error(`No auth configured for ${formatModel(currentModel)}. Use Pi auth/login first.`);
      return key;
    },
  });

  const loaded = sessionManager.buildSessionContext();
  if (loaded.messages.length > 0) agent.state.messages = loaded.messages;

  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: scratchDir,
    modelRegistry,
    resourceLoader,
    baseToolsOverride,
    customTools,
  });

  wireSessionUpdates(session, runState);
  const sessionOps = createSessionOps({ session, sessionManager, modelRegistry, settingsManager, runState });

  return {
    async run(ctx) {
      appendSystemPrompt = buildAppendSystemPrompt(workspaceDir, conversationKey, getMemory(conversationDir));
      return runAgentTurn({ ctx, conversationDir, scratchDir, sessionManager, agent, session, runState, resourceLoader });
    },
    abort(): void {
      void session.abort();
    },
    ...sessionOps,
  };
}
