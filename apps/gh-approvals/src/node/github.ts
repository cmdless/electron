import fs from 'node:fs/promises';
import { writeAtomic } from './util.js';

const API = 'https://api.github.com';

// how long an answer is kept once nothing has asked for it
const FORGET_AFTER_MS = 7 * 24 * 60 * 60_000;

// an answer: its body, the next page's URL if there is one, and how long
// GitHub asks to be left before polling again (the notifications API says)
export type Answer<T> = { body: T; next?: string; pollInterval?: number };

// what GitHub last answered for a URL, and how to ask whether it's changed
type Entry = Answer<unknown> & { etag?: string; lastModified?: string; usedAt: number };

// the rate limit as GitHub last reported it: how many requests are left of
// how many, and when it starts over
export type RateLimit = { remaining: number; limit: number; resetAt: string };

// GitHub's REST API, asked conditionally: each GET carries what was last seen
// for it, and an unchanged answer (304) comes back from the cache - which
// costs nothing against the rate limit. The cache is kept in a file of its
// own, so a restart is free too.
export class GitHub {
  private cache = new Map<string, Entry>();
  private changed = false;
  // what's been asked since the last count: how many, and which cost
  // something (answered in full, rather than 304)
  private asked = 0;
  private paid: string[] = [];
  // as of the latest answer that said
  rateLimit?: RateLimit;

  // every answer says where the rate limit stands, 304s included
  private noteRateLimit(response: Response) {
    const remaining = Number(response.headers.get('x-ratelimit-remaining'));
    const limit = Number(response.headers.get('x-ratelimit-limit'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (!limit || Number.isNaN(remaining)) return;
    this.rateLimit = { remaining, limit, resetAt: new Date(reset * 1000).toISOString() };
  }

  // how many requests were made since it was last asked, and which of them
  // cost something - starting the count again
  count() {
    const counted = { asked: this.asked, paid: this.paid };
    this.asked = 0;
    this.paid = [];
    return counted;
  }

  constructor(private readonly file: string, private readonly userAgent: string) { }

  async load() {
    const text = await fs.readFile(this.file, 'utf8').catch(() => '{}');
    try {
      this.cache = new Map(Object.entries(JSON.parse(text) as Record<string, Entry>));
    } catch {
      this.cache = new Map();
    }
  }

  // writes the cache out if it's changed, forgetting what's gone unused
  async save() {
    const cutoff = Date.now() - FORGET_AFTER_MS;
    for (const [url, entry] of this.cache) {
      if (entry.usedAt < cutoff) {
        this.cache.delete(url);
        this.changed = true;
      }
    }
    if (!this.changed) return;
    this.changed = false;
    await writeAtomic(this.file, JSON.stringify(Object.fromEntries(this.cache)));
  }

  private headers(token: string) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  // marks a notification thread done, as Done does in the inbox: it leaves
  // the inbox until something new happens on it
  async markDone(token: string, threadId: string) {
    this.asked++;
    const response = await fetch(`${API}/notifications/threads/${threadId}`, { method: 'DELETE', headers: this.headers(token) });
    this.noteRateLimit(response);
    this.paid.push(`DELETE /notifications/threads/${threadId}`);
    if (!response.ok) throw new Error(`GitHub ${response.status} marking notification ${threadId} done`);
  }

  async get<T>(token: string, path: string): Promise<Answer<T>> {
    const url = path.startsWith('https://') ? path : `${API}${path}`;
    const cached = this.cache.get(url);
    this.asked++;
    const response = await fetch(url, {
      headers: {
        ...this.headers(token),
        ...(cached?.etag ? { 'If-None-Match': cached.etag } : {}),
        ...(cached?.lastModified ? { 'If-Modified-Since': cached.lastModified } : {}),
      },
    });
    this.noteRateLimit(response);
    const where = new URL(url).pathname + new URL(url).search;

    if (response.status === 304 && cached) {
      // kept in memory only: an unchanged answer isn't worth a write
      cached.usedAt = Date.now();
      const pollInterval = Number(response.headers.get('x-poll-interval')) || cached.pollInterval;
      return { body: cached.body as T, next: cached.next, pollInterval };
    }
    // anything else costs, a failed answer too
    this.paid.push(where);
    if (!response.ok) {
      const { message } = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(`GitHub ${response.status} for ${new URL(url).pathname}: ${message ?? response.statusText}`);
    }

    const body = await response.json() as T;
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1];
    const pollInterval = Number(response.headers.get('x-poll-interval')) || undefined;
    this.cache.set(url, {
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      body, next, pollInterval, usedAt: Date.now(),
    });
    this.changed = true;
    return { body, next, pollInterval };
  }

  // every page of a list, each one asked conditionally
  async all<T>(token: string, path: string): Promise<Answer<T[]>> {
    const first = await this.get<T[]>(token, path);
    const items = [...first.body];
    for (let next = first.next; next;) {
      const page = await this.get<T[]>(token, next);
      items.push(...page.body);
      next = page.next;
    }
    return { body: items, pollInterval: first.pollInterval };
  }
}
