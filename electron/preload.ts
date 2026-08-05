import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/types';

/** Events the main process is allowed to push into the renderer. */
const EVENT_CHANNELS = [
  'consume:messages',
  'consume:progress',
  'terminal:data',
  'terminal:exit',
  'terminal:sessions',
  'menu:new-terminal',
  'menu:toggle-terminal',
  'menu:new-cluster',
  'menu:refresh',
  'menu:toggle-theme',
  'menu:palette',
] as const;

export type EventChannel = (typeof EVENT_CHANNELS)[number];

const api = {
  async invoke<T>(channel: string, payload?: unknown): Promise<T> {
    const result = (await ipcRenderer.invoke(`erebus:${channel}`, payload)) as IpcResult<T>;
    if (!result?.ok) throw new Error(result?.error ?? 'Request failed');
    return result.data as T;
  },
  on(channel: EventChannel, listener: (payload: unknown) => void): () => void {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`Channel ${channel} is not allowed`);
    const wrapped = (_event: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(`erebus:${channel}`, wrapped);
    return () => ipcRenderer.removeListener(`erebus:${channel}`, wrapped);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('erebus', api);

export type ErebusBridge = typeof api;
