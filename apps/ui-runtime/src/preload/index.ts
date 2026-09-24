import { cmdlessProtocol, createElectronIPC, type Cmdless } from '@cmdless/ui-sdk';
import { contextBridge, ipcRenderer } from 'electron';

const ipc = cmdlessProtocol.createClient(createElectronIPC(ipcRenderer));
const cmdless: Cmdless = { ipc };

contextBridge.exposeInMainWorld('cmdless', cmdless);
ipc.listen();