import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { spawnAsPackage, createShowCommand } from '@cmdless/ui-sdk/node';
import { conversationProtocol, ACP_AGENTS } from '../shared/index.js';
import { createInputPicker, pickerSource } from './ui.js';

// --- permission/elicitation pickers: these are ACP-level requests from the
// agent itself, not MCP tool calls, so they're plain node-internal show
// commands (not AppTools).

// null = the window was closed without a choice - a legitimate "cancelled"
// outcome here, not an error.
type PermissionChoice = { optionId: string } | null;
const pickPermission = createInputPicker<acp.RequestPermissionRequest, PermissionChoice>('/permission');

// null = window closed without an answer, distinct from an explicit decline.
type ElicitationChoice = { action: 'accept'; content: Record<string, acp.ElicitationContentValue> } | { action: 'decline' } | null;
const pickElicitation = createInputPicker<acp.CreateElicitationRequest, ElicitationChoice>('/elicitation');

function getAgentDefinition(agent: string) {
  const definition = ACP_AGENTS.find(candidate => candidate.id === agent);
  if (!definition)
    throw new Error(`Unknown agent "${agent}" - expected one of: ${ACP_AGENTS.map(candidate => candidate.id).join(', ')}`);
  return definition;
}

// model/mode map onto ACP's session config surface (see AcpSession below);
// config is a flat configOption-id -> value map for whatever else the
// agent exposes, applied via session/set_config_option directly. A value
// can be a real boolean (what pickSessionConfig sends for a boolean-type
// option, since it knows each option's actual type) or a string (the
// CLI-facing shape - a --flag is always text, so a boolean option set that
// way still goes out as a string, not ACP's native boolean).
export type AcpSessionConfig = {
  model?: string;
  mode?: string;
  config?: Record<string, string | boolean>;
};

export type AcpSession = {
  // both carry their own current/default value already (SessionModeState's
  // currentModeId, each SessionConfigOption's currentValue) - a session's
  // defaults are exactly what's already active, nothing to apply for them.
  readonly modes: acp.SessionModeState | null | undefined;
  readonly configOptions: acp.SessionConfigOption[] | null | undefined;
  setMode: (modeId: string) => Promise<void>;
  setConfigOption: (configId: string, value: string | boolean) => Promise<void>;
  // fire-and-forget - the actual response streams in via nextUpdate(),
  // which is what the conversation window (below) actually displays.
  sendPrompt: (text: string) => void;
  nextUpdate: () => Promise<acp.ActiveSessionMessage>;
  dispose: () => Promise<void>;
};

export async function createAcpSession(agent: string, directory: string): Promise<AcpSession> {
  const definition = getAgentDefinition(agent);
  const child = await spawnAsPackage(import.meta, definition.packageName, [...definition.args]);

  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // connectWith owns the connection for the entire lifetime of its callback
  // (closing it once the callback settles), so this bridges that one
  // long-running scope to a request/response-style handle: the callback
  // parks on `closed` right after the session exists, and `ready`/`closed`
  // hand the session (and the context needed to keep calling agent-side
  // methods on it) out to, and take a dispose signal back in from, the rest
  // of this function.
  let resolveReady!: (value: { ctx: acp.ClientContext; session: acp.ActiveSession }) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<{ ctx: acp.ClientContext; session: acp.ActiveSession }>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

  const connection = acp.client({ name: 'agent-runner' })
    .onRequest(acp.methods.client.session.requestPermission, async requestCtx => {
      const choice = await pickPermission(requestCtx.params);
      return { outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } };
    })
    .onRequest(acp.methods.client.elicitation.create, async requestCtx => {
      // url mode isn't supported yet - only form mode has a picker.
      if (requestCtx.params.mode !== 'form') return { action: 'decline' };
      const choice = await pickElicitation(requestCtx.params);
      return choice ?? { action: 'cancel' };
    })
    .connectWith(stream, async ctx => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await ctx.buildSession(directory).start();
      resolveReady({ ctx, session });
      await closed; // keep the connection (and this session) alive until dispose()
      session.dispose();
    });
  connection.catch(rejectReady);

  const { ctx, session } = await ready;

  return {
    modes: session.modes,
    configOptions: session.newSessionResponse.configOptions,
    setMode: async modeId => {
      await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId });
    },
    setConfigOption: async (configId, value) => {
      const params = typeof value === 'boolean'
        ? { sessionId: session.sessionId, configId, value, type: 'boolean' as const }
        : { sessionId: session.sessionId, configId, value };
      await ctx.request(acp.methods.agent.session.setConfigOption, params);
    },
    sendPrompt: text => { session.prompt(text); },
    nextUpdate: () => session.nextUpdate(),
    dispose: async () => {
      resolveClosed();
      await connection;
      child.kill();
    },
  };
}

// applies exactly what's given - called whenever the caller supplied any of
// model/mode/config explicitly, so no picker UI is shown at all.
export async function applySessionConfig(session: AcpSession, requested: AcpSessionConfig): Promise<void> {
  if (requested.mode !== undefined)
    await session.setMode(requested.mode);

  if (requested.model !== undefined) {
    // no dedicated "set model" method - model selection is just a
    // configOption whose category happens to be "model".
    const modelOption = session.configOptions?.find(option => option.category === 'model');
    if (!modelOption) throw new Error(`Agent has no "model" config option to set`);
    await session.setConfigOption(modelOption.id, requested.model);
  }

  if (requested.config)
    for (const [configId, value] of Object.entries(requested.config))
      await session.setConfigOption(configId, value);
}

// --- the conversation window: opened once directory/prompt/agent/config
// are all resolved and the session exists. This is the *last* step of
// runAgent, not a side effect during it - a live, bidirectional channel
// (unlike the pickers above, which are one question each) that streams the
// session's updates in and lets the user send follow-up prompts, for as
// long as the window stays open. Closing it is what ends the run - the
// caller disposes the session once this resolves. (conversationProtocol
// itself lives in shared/protocols.ts, so the renderer can connect with it
// too - see browser/routes/Conversation.tsx.)

// onUpdate is called for every update for as long as the window stays
// open, regardless of how many prompt turns happen - it's how the caller
// (runAgent) builds the full transcript to hand back once the window
// closes, since the window's own resolve value has no reason to carry it.
type ConversationInput = { session: AcpSession; initialPrompt: string; onUpdate: (update: acp.SessionUpdate) => void };

export const showConversation = createShowCommand<ConversationInput, void>({
  params: () => ({ type: 'file', source: pickerSource('/conversation') }),
  transport: async ({ session, initialPrompt, onUpdate }) => {
    const { accept } = await conversationProtocol.defineHost({
      configure: peer => {
        peer.onRequest.sendPrompt(({ text }) => { session.sendPrompt(text); });
        // pumps session updates to the window for as long as it's open -
        // once the window closes and the caller disposes the session,
        // nextUpdate() rejects and this loop ends on its own.
        (async () => {
          session.sendPrompt(initialPrompt);
          for (;;) {
            const result = await session.nextUpdate();
            if (result.kind === 'stop') { peer.notify.stop({ stopReason: result.stopReason }); continue; }
            onUpdate(result.update);
            peer.notify.update(result.notification);
          }
        })().catch(() => { });
      },
    })();
    return { accept, options: { port: 0, host: '127.0.0.1' } };
  },
});

// splits a run of updates into distinct agent messages - each contiguous
// run of agent_message_chunk text is one message; anything else (a tool
// call, plan, etc. in between) ends the current one. "The last message"
// means the last of these, not the whole run's text glued together.
function collectMessages(updates: readonly acp.SessionUpdate[]): string[] {
  const messages: string[] = [];
  let inMessage = false;
  for (const update of updates) {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      if (!inMessage) messages.push('');
      messages[messages.length - 1] += update.content.text;
      inMessage = true;
    } else {
      inMessage = false;
    }
  }
  return messages;
}

// the headless ("last-message") output mode: sends a prompt, then returns
// just its last distinct agent message as a string - no window involved.
export async function promptForMessage(session: AcpSession, text: string): Promise<string> {
  session.sendPrompt(text);
  const updates: acp.SessionUpdate[] = [];
  for (;;) {
    const result = await session.nextUpdate();
    if (result.kind === 'stop') break;
    updates.push(result.update);
  }
  const messages = collectMessages(updates);
  return messages[messages.length - 1] ?? '';
}

// shown only when the caller gave none of model/mode/config. Unlike the
// other pickers, closing this window means "use the session's own
// defaults" rather than "cancel" - it resolves null instead of throwing,
// and runAgent just skips applySessionConfig when it gets null back. Input
// is just the plain data the window renders from (modes/configOptions, not
// the live AcpSession itself - that has function members and can't cross
// the wire as a get() response), each already carrying its own
// current/default value, which the window pre-selects.
type SessionConfigInput = {
  modes: acp.SessionModeState | null | undefined;
  configOptions: acp.SessionConfigOption[] | null | undefined;
};
const pickSessionConfig_ = createInputPicker<SessionConfigInput, AcpSessionConfig | null>('/session-config');

export async function pickSessionConfig(session: AcpSession): Promise<AcpSessionConfig | null> {
  const choice = await pickSessionConfig_({ modes: session.modes, configOptions: session.configOptions });
  return choice;
}
