import type { Cmdless } from '../index.js';

export class CmdlessRenderer {
  get attached() { return !!window.cmdless; }
  get connected() { return false; }
  get cmdless() {
    if (!window.cmdless)
      throw new Error('window.cmdless not found');
    return window.cmdless;
  }
}

export type { Cmdless };