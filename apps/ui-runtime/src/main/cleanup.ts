// Removes a throwaway (ephemeral) host's userData once its host has gone.
// Electron main starts this, detached, with userData, and holds the write
// end of its stdin: whichever way main ends - quitting, crashing, killed -
// the OS closes that pipe, and this hears it as stdin ending. It runs as plain Node (ELECTRON_RUN_AS_NODE), so nothing
// here may touch electron.
import fs from 'node:fs';

// how long Chromium's helper processes get to finish with the directory,
// and how long to keep making sure it stays gone
const SETTLE_MS = 500;
const RECHECK_MS = [2_000, 5_000];

const [userData] = process.argv.slice(2);

// fs.rm itself retries what a still-open file throws (EBUSY, EPERM,
// ENOTEMPTY and the like)
const remove = () => fs.promises.rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => { });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

process.stdin.on('end', async () => {
  // ui-sdk is only loaded now, so this sits idle as bare Node until then
  const { isEphemeralUserData } = await import('@cmdless/ui-sdk/node');
  // only ever an ephemeral app's userData
  if (userData && isEphemeralUserData(userData)) {
    await wait(SETTLE_MS);
    await remove();
    // a helper that was still flushing can bring it back
    for (const ms of RECHECK_MS) {
      await wait(ms);
      if (fs.existsSync(userData)) await remove();
    }
  }
  process.exit(0);
});
process.stdin.resume();
