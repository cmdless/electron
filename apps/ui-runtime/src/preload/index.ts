import type { Cmdless } from '@cmdless/ui-sdk/shared';
import { contextBridge, ipcRenderer } from 'electron';

const cmdless: Cmdless = {
  invoke(method, args) {
    return ipcRenderer.invoke('cmdless:invoke', method, args);
  }
};

contextBridge.exposeInMainWorld('cmdless', cmdless);