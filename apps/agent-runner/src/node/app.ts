import fs from 'node:fs/promises';
import { createApp } from '@cmdless/ui-sdk/node';
import { spec } from '../shared/index.js';
import { createPicker } from './ui.js';
import { createAcpSession, applySessionConfig, pickSessionConfig, showConversation, promptForMessage } from './acp.js';

async function resolvePromptText(promptSource: string): Promise<string> {
  try {
    return await fs.readFile(promptSource, 'utf8');
  } catch {
    return promptSource; // not a file path - treat as literal prompt text
  }
}

const createAgentRunner = createApp({
  spec,
  setup: () => {
    const pickDirectory = createPicker<{ directory: string }>('/pick-directory');
    const pickPrompt = createPicker<{ prompt: string }>('/pick-prompt');
    const pickAgent = createPicker<{ agent: string }>('/pick-agent');

    return {
      // wrapped rather than handed over directly - each tool's input
      // schema is an empty object (`{}`), not void, but these take no
      // input at all internally, so the extra (ignored) parameter is only
      // there to satisfy ToolHandler's shape.
      pickDirectory: () => pickDirectory(),
      pickPrompt: () => pickPrompt(),
      pickAgent: () => pickAgent(),

      // resolution order matters: directory, prompt, and agent are all
      // resolved *before* an ACP session is created, so cancelling any of
      // them never leaves a session behind. Session/model config is the
      // one exception - ACP only reports a session's available
      // models/modes once the session itself exists (session/new's
      // response), so it can't be resolved any earlier.
      runAgent: async input => {
        const { directory } = input.directory ? { directory: input.directory } : await pickDirectory();
        const { prompt: promptSource } = input.prompt ? { prompt: input.prompt } : await pickPrompt();
        const { agent } = input.agent ? { agent: input.agent } : await pickAgent();
        const prompt = await resolvePromptText(promptSource);

        const session = await createAcpSession(agent, directory);
        try {
          // any of model/mode/config given at all -> apply exactly that, no
          // UI. None given -> show a picker for whatever the session itself
          // advertises; closing *that* window (unlike the other pickers)
          // means "use the session's own defaults", not "cancel" - it comes
          // back null, and applySessionConfig is skipped entirely.
          const hasExplicitConfig = input.model !== undefined || input.mode !== undefined || input.config !== undefined;
          const config = hasExplicitConfig
            ? { model: input.model, mode: input.mode, config: input.config }
            : await pickSessionConfig(session);
          if (config) await applySessionConfig(session, config);

          // 'conversation' is the last step, not a side effect along the
          // way: shows the session's turns and lets the user send
          // follow-ups for as long as the window stays open, closing it
          // ends the run. 'last-message' (the default) never opens a
          // window at all - it's the one-shot, just-collecting-input shape
          // for callers that only want an answer back.
          if (input.outputType === 'conversation') {
            const transcript: unknown[] = [];
            await showConversation({ session, initialPrompt: prompt, onUpdate: update => transcript.push(update) });
            return { output: JSON.stringify(transcript) };
          }
          const message = await promptForMessage(session, prompt);
          return { output: message };
        } finally {
          await session.dispose();
        }
      },
    };
  },
});

export default createAgentRunner;
