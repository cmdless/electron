import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// how long gh gets to come up with a one-time code
const CODE_TIMEOUT_MS = 20_000;

// whether the gh CLI is installed, by asking the platform where it is
export async function ghInstalled() {
  try {
    await run(process.platform === 'win32' ? 'where' : 'which', ['gh']);
    return true;
  } catch {
    return false;
  }
}

// a GitHub account's token from gh, without making it gh's active account -
// or nothing, if gh isn't signed in to it
export async function tokenFor(user: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', user]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// a sign-in gh is running: the one-time code to enter at `url`, and whether it
// finished once it's done (gh stores the account itself)
export type Login = {
  code: string;
  url: string;
  done: Promise<boolean>;
  cancel(): void;
};

// gh's own device-code sign-in, run with no terminal: it prints the code and
// where to enter it rather than opening anything, then waits for the browser
// side to finish
export function startLogin(): Promise<Login> {
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = new Promise<boolean>(resolve => {
    child.once('exit', code => resolve(code === 0));
    child.once('error', () => resolve(false));
  });

  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => fail(new Error('gh didn\'t give a one-time code')), CODE_TIMEOUT_MS);
    const fail = (error: Error) => {
      clearTimeout(timer);
      child.kill();
      reject(error);
    };
    const read = (chunk: Buffer) => {
      output += chunk;
      const code = output.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
      const url = output.match(/(https:\/\/\S+\/login\/device)/)?.[1];
      if (!code || !url) return;
      clearTimeout(timer);
      resolve({ code, url, done, cancel: () => child.kill() });
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    void done.then(() => fail(new Error(`gh stopped before giving a code: ${output.trim()}`)));
  });
}
