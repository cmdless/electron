import { fileURLToPath } from 'node:url';
import { acquireCmdlessUrl } from '@cmdless/ui-sdk/node';

// a window's page, by its route: the dev server's, when running under it, or
// the built one
export const page = (route: string) =>
  `${acquireCmdlessUrl() || fileURLToPath(new URL('../../dist/index.html', import.meta.url))}#${route}`;
