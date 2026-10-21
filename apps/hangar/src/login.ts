import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { Agent, Session, Start } from '@ahpd/sdk';
import { CmdlessUI } from '@cmdless/ui-sdk/node';

// an agent CLI's own sign-in: whether it's signed in, and a sign-in that
// hands back the URL to open and finishes once the browser reaches its
// callback
export type CliLogin = {
  title: string;
  signedIn(): Promise<boolean>;
  start(): Promise<LoginRun>;
};

export type LoginRun = {
  // the sign-in page, which redirects to `callback` when it's done
  url: string;
  callback: string;
  // settles when the CLI has finished: true once it's signed in
  done: Promise<boolean>;
  cancel(): void;
};

// opens a sign-in page on this machine, and resolves with where it
// redirected once it reaches `callback` - or nothing, if it was closed
export type OpenSignIn = (url: string, callback: string, title: string) => Promise<string | undefined>;

// sign-in windows leave the app name unset, so each is an app of its own -
// one that can be closed, and whose data ui-runtime cleans up
export const openWindow: OpenSignIn = async (url, callback, title) => {
  const redirectedTo = await new CmdlessUI().show({
    kind: 'show', type: 'url', source: url, title, width: 520, height: 720, redirect: callback,
  });
  return redirectedTo.startsWith(callback) ? redirectedTo : undefined;
};

// opens a page an agent asked to have opened, on this machine, until the
// signal says it's done with
export type OpenPage = (url: string, title: string, signal: AbortSignal) => Promise<unknown>;

export const openPage: OpenPage = (url, title, signal) => new CmdlessUI().show({
  kind: 'show', type: 'url', source: url, title, width: 520, height: 720, external: true,
}, { signal });

// runs a CLI sign-in with BROWSER pointed at a script that writes down the
// URL it was asked to open, rather than opening it
async function runCatchingBrowser(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'hangar-login-'));
  const caught = path.join(folder, 'url');
  const browser = path.join(folder, 'browser');
  await writeFile(browser, `#!/bin/sh\nprintf '%s' "$1" > '${caught}'\n`);
  await chmod(browser, 0o700);

  const child = spawn(command, args, { env: { ...process.env, ...env, BROWSER: browser }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  const exited = new Promise<number | null>(resolve => child.on('close', resolve));
  void exited.finally(() => rm(folder, { recursive: true, force: true }));

  // the CLI calls BROWSER as soon as its callback is listening
  const url = await new Promise<string>((resolve, reject) => {
    const poll = setInterval(async () => {
      const found = await readFile(caught, 'utf8').catch(() => '');
      if (found) { clearInterval(poll); resolve(found); }
    }, 100);
    void exited.then(code => { clearInterval(poll); reject(new Error(`${command} exited (${code}) before opening a sign-in page: ${output.trim()}`)); });
  });
  return { url, exited, kill: () => child.kill() };
}

// Claude Code's own sign-in, through the CLI the Claude Agent SDK ships - the
// same one ahpd's Claude agent runs, so what it signs in is what sessions use
export function claudeLogin(cli = claudeCli()): CliLogin {
  return {
    title: 'Sign in to Claude',
    async signedIn() {
      const status = await new Promise<string>((resolve, reject) => {
        const child = spawn(cli, ['auth', 'status', '--json']);
        let out = '';
        child.stdout.on('data', chunk => out += chunk);
        child.on('error', reject);
        child.on('close', () => resolve(out));
      });
      try {
        return JSON.parse(status).loggedIn === true;
      } catch {
        return false;
      }
    },
    async start() {
      const { url, exited, kill } = await runCatchingBrowser(cli, ['auth', 'login']);
      const callback = new URL(url).searchParams.get('redirect_uri');
      if (!callback) throw new Error('the Claude sign-in page has no redirect_uri');
      return { url, callback, done: exited.then(code => code === 0), cancel: kill };
    },
  };
}

// the Claude Code binary from the SDK's package for this platform
function claudeCli() {
  const require = createRequire(createRequire(import.meta.url).resolve('@ahpd/agent-claude'));
  // the SDK exports no package.json, so it's found by its entry point
  const sdk = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'));
  const platform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return path.join(path.dirname(sdk.resolve(`${platform}/package.json`)), 'claude');
}

// An agent whose sessions sign its CLI in when it isn't. A turn that starts
// signed out asks for the sign-in in the chat - a URL input request, which the
// host completes itself - opens the sign-in page on this machine, and hands
// the redirect back to the CLI's own callback. Once it's signed in, the turn
// runs as it would have.
export function withCliLogin(agent: Agent, login: CliLogin, open: OpenSignIn = openWindow): Agent {
  // one sign-in at a time, shared by every session that needs one
  let pending: Promise<boolean> | undefined;
  let current: LoginRun | undefined;

  const signIn = (onUrl: (url: string) => void) => pending ??= (async () => {
    try {
      const run = current = await login.start();
      onUrl(run.url);
      void open(run.url, run.callback, login.title).then(async redirectedTo => {
        // the window's gone either way; a redirect is handed to the CLI's
        // own listener, which is what finishes the sign-in
        if (redirectedTo) await fetch(redirectedTo).catch(() => { });
        else run.cancel();
      }, () => run.cancel());
      return await run.done;
    } finally {
      pending = current = undefined;
    }
  })();

  return {
    ...agent,
    create(start: Start): Session {
      const inner = agent.create(start);
      const emit = start.emit;
      // the sign-in a turn of this session is waiting on, by its request id
      let waiting: { requestId: string; turnId: string; started: number } | undefined;

      const fail = (turnId: string, started: number, message: string) => emit('chat', {
        type: 'chat/error', turnId, duration: Date.now() - started,
        part: { kind: 'error', error: { errorType: 'signInRequired', message } },
      });

      return {
        ...inner,
        begin(...args: Parameters<Session['begin']>) {
          const [turnId] = args;
          void (async () => {
            if (await login.signedIn()) return inner.begin(...args);
            const requestId = `sign-in-${turnId}`;
            const started = Date.now();
            waiting = { requestId, turnId, started };
            // an agent says its own turns back, so this one is said here while
            // the agent hasn't heard of it - the agent says it again when it does
            const [, text] = args;
            emit('chat', {
              type: 'chat/turnStarted', turnId, startedAt: new Date(started).toISOString(),
              message: { text, origin: { kind: 'user' } },
            });
            const signedIn = await signIn(url => emit('chat', {
              type: 'chat/inputRequested',
              request: { id: requestId, message: `${login.title} in the window that opened on ${os.hostname()}.`, url },
            })).catch(error => { console.error('hangar: sign-in failed:', error); return false; });
            if (waiting?.requestId !== requestId) return;
            waiting = undefined;
            if (!signedIn) return fail(turnId, started, `${login.title} didn't finish, so this message wasn't sent.`);
            emit('chat', { type: 'chat/inputCompleted', requestId, response: 'accept' });
            inner.begin(...args);
          })();
        },
        answer(requestId: string, accepted: boolean, answers: Record<string, unknown>, response?: 'accept' | 'decline' | 'cancel') {
          if (waiting?.requestId !== requestId) return inner.answer(requestId, accepted, answers, response);
          // only a person can say no here - a sign-in is finished by the CLI
          if (response !== 'accept') {
            const { turnId, started } = waiting;
            waiting = undefined;
            current?.cancel();
            emit('chat', { type: 'chat/inputCompleted', requestId, response: response ?? 'decline' });
            fail(turnId, started, `${login.title} was cancelled, so this message wasn't sent.`);
          }
          return true;
        },
        cancel(turnId: string) {
          if (waiting?.turnId !== turnId) return inner.cancel(turnId);
          waiting = undefined;
          current?.cancel();
        },
      };
    },
  };
}

// An agent whose requests to open a page - an ACP agent's device-code
// sign-in, say - open the page in a window on this machine, titled with what
// the request says (the code to enter, for one). The window closes when the
// agent says the request is done; closing it first leaves the request open,
// for the chat's link or Cancel.
export function withLocalPages(agent: Agent, open: OpenPage = openPage): Agent {
  return {
    ...agent,
    create(start: Start): Session {
      const windows = new Map<string, AbortController>();
      const emit: Start['emit'] = (channel, action) => {
        if (channel === 'chat' && action.type === 'chat/inputRequested') {
          const request = action.request as { id: string; url?: string; message?: string; questions?: unknown[] };
          if (request.url && !request.questions?.length && !windows.has(request.id)) {
            const controller = new AbortController();
            windows.set(request.id, controller);
            void open(request.url, request.message ?? agent.displayName, controller.signal)
              .catch(() => { })
              .finally(() => { if (windows.get(request.id) === controller) windows.delete(request.id); });
          }
        } else if (channel === 'chat' && action.type === 'chat/inputCompleted') {
          close(action.requestId as string);
        }
        start.emit(channel, action);
      };
      const close = (requestId: string) => {
        const controller = windows.get(requestId);
        windows.delete(requestId);
        controller?.abort(new Error('the request is done'));
      };
      const session = agent.create({ ...start, emit });
      // a person answering - cancelling, say - is done with the page too
      return {
        ...session,
        answer(requestId, ...rest) {
          close(requestId);
          return session.answer(requestId, ...rest);
        },
      };
    },
  };
}
