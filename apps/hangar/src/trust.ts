import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// a folder as trust.json keeps it: absolute, ~ expanded, no trailing slash
export function trustedPath(folder: string) {
  const expanded = folder === '~' || folder.startsWith('~/') ? path.join(os.homedir(), folder.slice(1)) : folder;
  if (!path.isAbsolute(expanded)) throw new Error(`not an absolute path: ${folder}`);
  return path.resolve(expanded);
}

// a TOML key, quoted ("..." with escapes) or literal ('...')
function unquote(key: string) {
  if (key.startsWith("'")) return key.slice(1, -1);
  return JSON.parse(key) as string;
}

// the projects Codex's config.toml marks trusted: each `[projects."<path>"]`
// table whose trust_level is "trusted". Read by line rather than with a TOML
// parser, since that's the one shape Codex writes them in.
export async function codexTrustedProjects() {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  let text: string;
  try {
    text = await readFile(path.join(home, 'config.toml'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const trusted: string[] = [];
  let project: string | undefined;
  for (const line of text.split('\n').map(each => each.trim())) {
    if (line.startsWith('[')) {
      const match = /^\[projects\.("(?:[^"\\]|\\.)*"|'[^']*')\]$/.exec(line);
      project = match ? unquote(match[1]) : undefined;
    } else if (project && /^trust_level\s*=\s*"trusted"\s*(#.*)?$/.test(line)) {
      trusted.push(project);
    }
  }
  return trusted;
}
