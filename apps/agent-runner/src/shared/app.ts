import { defineApp } from '@cmdless/ui-sdk';

export const spec = defineApp(({ tool, z }) => ({
  name: 'agent-runner',
  description: 'Runs a coding agent against a prompt and a working directory',
  tools: {
    pickDirectory: tool('pickDirectory', 'Choose the working directory to run the agent on', {
      input: z.object({}),
      output: z.object({ directory: z.string() }),
    }),
    // a plain string here is either the prompt text itself, or a path to a
    // file to read it from - resolved on the node side, not distinguished
    // in the schema.
    pickPrompt: tool('pickPrompt', 'Choose a prompt, either typed directly or from a file', {
      input: z.object({}),
      output: z.object({ prompt: z.string() }),
    }),
    pickAgent: tool('pickAgent', 'Choose which agent to run', {
      input: z.object({}),
      output: z.object({ agent: z.string() }),
    }),
    // note: there's no requestInput/elicitation tool here - ACP already has
    // a native elicitation/create request for "the agent asks the user a
    // structured question", handled directly in acp.ts's client handlers,
    // not exposed as an MCP tool at all.
    // model/mode/config are intentionally not their own tool - ACP only
    // reports a session's available models/modes/config options once the
    // session itself exists (see session/new's response), so picking one
    // can't happen ahead of time. runAgent creates the session itself and
    // resolves those internally: if none of the three are given at all, it
    // shows a picker for whatever the session advertises; if any is given,
    // it applies exactly what was given and shows no config UI at all
    // (config is a flat map of arbitrary agent-specific option id -> value,
    // for whatever settings aren't covered by plain model/mode).
    // outputType controls what happens once the session's set up, and
    // what output ends up holding - both are always a plain string:
    // - 'last-message' (default): headless - send the initial prompt, wait
    //   for that one turn to finish, return just its last distinct agent
    //   message as text. No window at all - this is the "one shot, just
    //   collecting input" shape, for CLI/MCP callers that just want an
    //   answer back.
    // - 'conversation': opens the conversation window (see acp.ts) and lets
    //   the user watch/continue for as long as it stays open; once closed,
    //   output holds the whole run's updates as a single JSON-serialized
    //   array - deliberately not concatenated into text, since that would
    //   throw away the structure (tool calls, distinct messages, etc.) a
    //   receiving end would need to actually parse it back out.
    runAgent: tool('runAgent', 'Run an agent session; shows UI for anything not provided', {
      input: z.object({
        directory: z.string().optional(),
        prompt: z.string().optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        mode: z.string().optional(),
        config: z.record(z.string(), z.string()).optional(),
        outputType: z.enum(['last-message', 'conversation']).default('last-message'),
      }),
      output: z.object({ output: z.string() }),
    }),
  },
}));
