import { rejectService, resolveService } from './utils.js';

// a stand-in service for utils.test.ts: argv[2] picks how it reports back
const mode = process.argv[2];

if (mode === 'resolve') {
  await resolveService({ pid: process.pid, args: process.argv.slice(3) });
  // stay alive like a real service would, until the test kills it
  setInterval(() => { }, 1 << 30);
} else if (mode === 'reject') {
  await rejectService(new Error('could not start'));
} else if (mode === 'exit') {
  process.exit(3);
}
