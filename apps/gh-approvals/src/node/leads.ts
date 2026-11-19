import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineProtocol } from '@cmdless/rpc-sdk';
import { createSocket, startSocket } from '@cmdless/rpc-sdk/node';

// someone approvals can be sent to: what they're called, the machine
// they're on, and their GitHub login
export type Lead = { name: string; machine: string; user: string };

// ready: their gh-approvals answered, with the token they wrote; offline:
// it didn't (not running, a stale token, or a firewall in the way);
// checking: not known yet
export type LeadStatus = 'checking' | 'ready' | 'offline';

// something a lead can be sent: a pull request to review, or a deployment
// to approve
export type SentItem = { kind: 'pull-request' | 'deployment'; title: string; url: string };

// where every lead's gh-approvals listens
export const LEAD_PORT = 56789;

// how long a lead's machine gets to answer before it counts as offline
const CONNECT_TIMEOUT_MS = 2_000;

// Every request carries the receiving lead's token. A lead writes theirs to
// .{user}.json beside the leads file each time it starts, so only someone
// who can read that folder can reach them - the folder is the trust.
export const leadProtocol = defineProtocol(({ side, request }) => ({
  clientToServer: side({
    requests: {
      ping: request<{ token: string }>('ping'),
      send: request<{ token: string; from: string; item: SentItem }>('send'),
    },
  }),
}));

// the leads file: [{ "name": "...", "machine": "<host>", "user": "<GitHub login>" }, ...]
// - no file at all is no leads
export async function readLeads(file: string): Promise<Lead[]> {
  const text = await fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  });
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} isn't a list of leads`);
  return parsed.map((entry, index) => {
    const { name, machine, user } = (entry ?? {}) as Partial<Lead>;
    if (typeof name !== 'string' || typeof machine !== 'string' || typeof user !== 'string')
      throw new Error(`lead ${index} in ${file} needs a name, a machine and a user`);
    return { name, machine, user };
  });
}

const tokenFile = (folder: string, user: string) => path.join(folder, `.${user}.json`);

// a fresh token for this run, written where the other leads will read it
export async function writeToken(folder: string, user: string) {
  const token = randomBytes(32).toString('base64url');
  await fs.writeFile(tokenFile(folder, user), JSON.stringify({ token }));
  return token;
}

// takes this lead's token away, so nobody reaches it with the old one
export async function removeToken(folder: string, user: string) {
  await fs.rm(tokenFile(folder, user), { force: true });
}

// a lead's current token - or nothing, if they haven't written one
async function readToken(folder: string, user: string) {
  const parsed = JSON.parse(await fs.readFile(tokenFile(folder, user), 'utf8').catch(() => '{}')) as { token?: unknown };
  return typeof parsed.token === 'string' ? parsed.token : undefined;
}

const sameToken = (presented: string, token: string) =>
  presented.length === token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(token));

// this lead's listener: only requests carrying this run's token get through
export async function serveLead(token: string, onSend: (from: string, item: SentItem) => void) {
  const check = (presented: string) => {
    if (!sameToken(presented, token)) throw new Error('wrong token');
  };
  const { accept } = await leadProtocol.defineHost({
    configure: server => {
      server.onRequest.ping(({ token: presented }) => check(presented));
      server.onRequest.send(({ token: presented, from, item }) => {
        check(presented);
        onSend(from, item);
      });
    },
  })();
  return startSocket({ accept, options: { port: LEAD_PORT } });
}

// a connection to a lead's listener, given up on if their machine doesn't
// answer in time
function connect({ machine }: Lead) {
  return new Promise<ReturnType<typeof leadProtocol.createClient>>((resolve, reject) => {
    const socket = net.connect({ host: machine, port: LEAD_PORT, timeout: CONNECT_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.setTimeout(0);
      const client = leadProtocol.createClient(createSocket(socket));
      client.listen();
      resolve(client);
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`${machine} didn't answer`)); });
    socket.once('error', reject);
  });
}

// asks a lead something, with their token, then hangs up
async function withLead<T>(folder: string, lead: Lead, ask: (client: Awaited<ReturnType<typeof connect>>, token: string) => Promise<T>) {
  const token = await readToken(folder, lead.user);
  if (!token) throw new Error(`${lead.name} hasn't started gh-approvals`);
  const client = await connect(lead);
  try {
    return await ask(client, token);
  } finally {
    client.dispose();
  }
}

// whether a lead's gh-approvals is up and holding the token they wrote
export async function probe(folder: string, lead: Lead): Promise<LeadStatus> {
  return withLead(folder, lead, (client, token) => client.request.ping({ token }))
    .then(() => 'ready' as const, () => 'offline' as const);
}

export function sendTo(folder: string, lead: Lead, from: string, item: SentItem) {
  return withLead(folder, lead, (client, token) => client.request.send({ token, from, item }));
}
