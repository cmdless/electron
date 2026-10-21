import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent, Session, Start } from '@ahpd/sdk';
import { withCliLogin, withLocalPages } from './login.js';
import type { CliLogin } from './login.js';

type Emitted = { channel: string; action: Record<string, unknown> };

// an agent whose sessions only record which turns began and which answers they got
function fakeAgent() {
  const begun: string[] = [];
  const answered: string[] = [];
  const agent = {
    provider: 'fake',
    create: () => ({
      begin: (turnId: string) => { begun.push(turnId); },
      answer: (requestId: string) => { answered.push(requestId); return true; },
      cancel: () => { },
    }) as unknown as Session,
  } as unknown as Agent;
  return { agent, begun, answered };
}

// a login that's signed out until it finishes, and finishes when told to
function fakeLogin() {
  let signedIn = false;
  let finish!: (ok: boolean) => void;
  let cancelled = false;
  const login: CliLogin = {
    title: 'Sign in to Fake',
    signedIn: async () => signedIn,
    start: async () => ({
      url: 'https://fake/authorize',
      callback: 'http://localhost:1/callback',
      done: new Promise<boolean>(resolve => finish = ok => { signedIn = ok; resolve(ok); }),
      cancel: () => { cancelled = true; finish(false); },
    }),
  };
  return { login, finish: (ok: boolean) => finish(ok), wasCancelled: () => cancelled, signIn: () => { signedIn = true; } };
}

function open(agent: Agent) {
  const emitted: Emitted[] = [];
  const session = agent.create({ emit: (channel: string, action: Record<string, unknown>) => emitted.push({ channel, action }) } as unknown as Start);
  return { session, emitted, types: () => emitted.map(each => each.action.type) };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('a signed-in agent begins the turn straight away', async () => {
  const { agent, begun } = fakeAgent();
  const fake = fakeLogin();
  fake.signIn();
  const { session, types } = open(withCliLogin(agent, fake.login, async () => undefined));
  session.begin('t1', 'hi');
  await tick();
  assert.deepEqual(begun, ['t1']);
  assert.deepEqual(types(), []);
});

test('a signed-out agent asks for the sign-in, then begins the turn once it finishes', async () => {
  const { agent, begun } = fakeAgent();
  const fake = fakeLogin();
  const opened: string[] = [];
  const { session, emitted, types } = open(withCliLogin(agent, fake.login, async url => { opened.push(url); return new Promise(() => { }); }));
  session.begin('t1', 'hi');
  await tick();
  assert.deepEqual(types(), ['chat/turnStarted', 'chat/inputRequested']);
  assert.equal((emitted[1].action.request as { url: string }).url, 'https://fake/authorize');
  assert.deepEqual(opened, ['https://fake/authorize']);
  assert.deepEqual(begun, []);

  fake.finish(true);
  await tick();
  assert.deepEqual(types(), ['chat/turnStarted', 'chat/inputRequested', 'chat/inputCompleted']);
  assert.deepEqual(begun, ['t1']);
});

test('declining the sign-in cancels it and fails the turn without beginning it', async () => {
  const { agent, begun, answered } = fakeAgent();
  const fake = fakeLogin();
  const { session, types } = open(withCliLogin(agent, fake.login, () => new Promise(() => { })));
  session.begin('t1', 'hi');
  await tick();
  assert.equal(session.answer('sign-in-t1', false, {}, 'decline'), true);
  await tick();
  assert.equal(fake.wasCancelled(), true);
  assert.deepEqual(types(), ['chat/turnStarted', 'chat/inputRequested', 'chat/inputCompleted', 'chat/error']);
  assert.deepEqual(begun, []);
  // answers to anything else still reach the agent
  session.answer('other', true, {});
  assert.deepEqual(answered, ['other']);
});

test('a window closed without signing in cancels the CLI and fails the turn', async () => {
  const { agent, begun } = fakeAgent();
  const fake = fakeLogin();
  const { session, types } = open(withCliLogin(agent, fake.login, async () => undefined));
  session.begin('t1', 'hi');
  await tick();
  assert.equal(fake.wasCancelled(), true);
  assert.deepEqual(types(), ['chat/turnStarted', 'chat/inputRequested', 'chat/error']);
  assert.deepEqual(begun, []);
});

// an agent whose session raises whatever it's told to, and records answers
function pageAgent() {
  let emit!: Start['emit'];
  const answered: string[] = [];
  const agent = {
    provider: 'pages', displayName: 'Pages',
    create: (start: Start) => {
      emit = start.emit;
      return { answer: (requestId: string) => { answered.push(requestId); return true; } } as unknown as Session;
    },
  } as unknown as Agent;
  return { agent, raise: (action: Record<string, unknown>) => emit('chat', action), answered };
}

function pages() {
  const opened: { url: string; title: string; signal: AbortSignal }[] = [];
  return { opened, open: async (url: string, title: string, signal: AbortSignal) => { opened.push({ url, title, signal }); } };
}

test('withLocalPages opens a page request titled with its message, and closes it when the agent completes it', async () => {
  const { agent, raise } = pageAgent();
  const { opened, open } = pages();
  const forwarded: unknown[] = [];
  withLocalPages(agent, open).create({ emit: (_: string, action: unknown) => forwarded.push(action) } as unknown as Start);
  raise({ type: 'chat/inputRequested', request: { id: 'r1', url: 'https://example.com/device', message: 'Enter ABCD-1234' } });
  assert.deepEqual(opened.map(({ url, title }) => ({ url, title })), [{ url: 'https://example.com/device', title: 'Enter ABCD-1234' }]);
  assert.equal(opened[0].signal.aborted, false);
  raise({ type: 'chat/inputCompleted', requestId: 'r1', response: 'accept' });
  assert.equal(opened[0].signal.aborted, true);
  assert.equal(forwarded.length, 2);
});

test('withLocalPages closes the page when someone answers, and leaves questions alone', async () => {
  const { agent, raise, answered } = pageAgent();
  const { opened, open } = pages();
  const session = withLocalPages(agent, open).create({ emit: () => { } } as unknown as Start);
  raise({ type: 'chat/inputRequested', request: { id: 'form', questions: [{ id: 'q' }], url: 'https://example.com' } });
  assert.equal(opened.length, 0);
  raise({ type: 'chat/inputRequested', request: { id: 'r1', url: 'https://example.com/device' } });
  assert.equal(opened[0].title, 'Pages');
  session.answer('r1', false, {}, 'cancel');
  assert.equal(opened[0].signal.aborted, true);
  assert.deepEqual(answered, ['r1']);
});
