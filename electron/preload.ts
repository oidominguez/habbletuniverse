import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { HabbletApi } from '../shared/ipc';
import type { SettingsPatch } from '../shared/addon-config';
import type { CaptchaSolverProvider, CrowdAccountInput, CrowdAccountPatch, CrowdNetworkSettings, HeadlessEvent, InterceptedHandshake, ProxyPhase, TorSettings, TurnstileSolveRequest } from '../shared/crowd';

/**
 * Ponte segura entre o renderer e o processo principal.
 * Roda com contextIsolation ligado: o renderer só vê `window.habblet`.
 */
const api: HabbletApi = {
  getAppVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION),

  openExternal: (url) => ipcRenderer.invoke(IPC.SHELL_OPEN_EXTERNAL, url),

  onWebviewOpenUrl: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on(IPC.WEBVIEW_OPEN_URL, listener);
    return () => ipcRenderer.removeListener(IPC.WEBVIEW_OPEN_URL, listener);
  },

  getWebviewPreloadPath: () => ipcRenderer.invoke(IPC.WEBVIEW_GET_PRELOAD),

  onShortcut: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, key: string) => callback(key);
    ipcRenderer.on(IPC.APP_SHORTCUT, listener);
    return () => ipcRenderer.removeListener(IPC.APP_SHORTCUT, listener);
  },

  log: {
    append: (source: string, message: string) => ipcRenderer.send(IPC.LOG_APPEND, source, message),
    path: () => ipcRenderer.invoke(IPC.LOG_PATH),
  },

  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    update: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.SETTINGS_UPDATE, patch),
    reset: () => ipcRenderer.invoke(IPC.SETTINGS_RESET),
    exportProfile: () => ipcRenderer.invoke(IPC.SETTINGS_EXPORT),
    importProfile: () => ipcRenderer.invoke(IPC.SETTINGS_IMPORT),
  },

  protocol: {
    marker: (text: string) => ipcRenderer.invoke(IPC.PROTO_MARKER, text),
    capturePath: () => ipcRenderer.invoke(IPC.PROTO_CAPTURE_PATH),
  },

  game: {
    furnidata: (force?: boolean) => ipcRenderer.invoke(IPC.GAME_FURNIDATA_GET, force === true),
  },

  crowd: {
    list: () => ipcRenderer.invoke(IPC.CROWD_LIST),
    add: (input: CrowdAccountInput) => ipcRenderer.invoke(IPC.CROWD_ADD, input),
    update: (id: string, patch: CrowdAccountPatch) => ipcRenderer.invoke(IPC.CROWD_UPDATE, id, patch),
    remove: (id: string) => ipcRenderer.invoke(IPC.CROWD_REMOVE, id),
    credentials: (id: string) => ipcRenderer.invoke(IPC.CROWD_CREDENTIALS, id),
    applyProxy: (id: string, phase?: ProxyPhase) => ipcRenderer.invoke(IPC.CROWD_PROXY_APPLY, id, phase ?? 'login'),
    testProxy: (id: string) => ipcRenderer.invoke(IPC.CROWD_PROXY_TEST, id),
    getSolver: () => ipcRenderer.invoke(IPC.CROWD_SOLVER_GET),
    setSolver: (provider: CaptchaSolverProvider, apiKey: string | null) => ipcRenderer.invoke(IPC.CROWD_SOLVER_SET, provider, apiKey),
    solveTurnstile: (req: TurnstileSolveRequest) => ipcRenderer.invoke(IPC.CROWD_SOLVER_SOLVE, req),
    getTor: () => ipcRenderer.invoke(IPC.CROWD_TOR_GET),
    setTor: (patch: Partial<TorSettings>) => ipcRenderer.invoke(IPC.CROWD_TOR_SET, patch),
    generateTorrc: () => ipcRenderer.invoke(IPC.CROWD_TOR_TORRC),
    launchTor: () => ipcRenderer.invoke(IPC.CROWD_TOR_LAUNCH),
    stopTor: () => ipcRenderer.invoke(IPC.CROWD_TOR_STOP),
    getNetwork: () => ipcRenderer.invoke(IPC.CROWD_NETWORK_GET),
    setNetwork: (patch: Partial<CrowdNetworkSettings>) => ipcRenderer.invoke(IPC.CROWD_NETWORK_SET, patch),
    getTraffic: () => ipcRenderer.invoke(IPC.CROWD_TRAFFIC_GET),
    resetTraffic: () => ipcRenderer.invoke(IPC.CROWD_TRAFFIC_RESET),
    headlessConnect: (id: string, handshake: InterceptedHandshake) => ipcRenderer.invoke(IPC.CROWD_HEADLESS_CONNECT, id, handshake),
    headlessSend: (id: string, header: number, bodyBase64: string) => ipcRenderer.send(IPC.CROWD_HEADLESS_SEND, id, header, bodyBase64),
    headlessDisconnect: (id: string) => ipcRenderer.invoke(IPC.CROWD_HEADLESS_DISCONNECT, id),
    onHeadlessEvent: (callback: (ev: HeadlessEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, ev: HeadlessEvent) => callback(ev);
      ipcRenderer.on(IPC.CROWD_HEADLESS_EVENT, listener);
      return () => ipcRenderer.removeListener(IPC.CROWD_HEADLESS_EVENT, listener);
    },
  },
};

contextBridge.exposeInMainWorld('habblet', api);
