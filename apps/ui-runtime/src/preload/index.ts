import type { Cmdless } from '@cmdless/ui-sdk/shared';
import { contextBridge, ipcRenderer } from 'electron';

const cmdless: Cmdless = {
  invoke(method, args) {
    return ipcRenderer.invoke('cmdless:invoke', method, args);
  },
  resolve(value, exitCode = 0) {
    ipcRenderer.send('cmdless:resolve', value, exitCode);
  },
};

contextBridge.exposeInMainWorld('cmdless', cmdless);