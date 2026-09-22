import './env'; // precisa ser o primeiro import: define userData antes do electron-store
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { WebContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { IPC } from '../shared/ipc';
import { BUILD_LABEL, BUILD_MODE, BUILD_TIME } from '../shared/build-info';
import type { ProfileFileResult } from '../shared/ipc';
import type { SettingsPatch } from '../shared/addon-config';
import { settingsStore, windowStore } from './store';
import { CaptureRecorder } from './capture-recorder';
import { headless, registerCrowdIpc } from './crowd-store';
import { appLog, enableChromiumLog, registerAppLog } from './app-log';
import { getFurniCatalog } from './furnidata';

const DEV_SERVER_URL = 'http://localhost:5173';

// HABBLET_OPEN abre uma tela ao iniciar ('addons', 'addons:<id>', 'dock') — usado com
// HABBLET_USER_DATA (ver env.ts) para inspecionar a interface numa instância isolada.

let mainWindow: BrowserWindow | null = null;

/**
 * Título da janela com a marca do build: é o que aparece na barra de tarefas, então dá para ver de
 * relance qual build está aberto sem entrar no app. `dev` = Vite; a data é a da compilação.
 */
function windowTitle(): string {
  return `Habblet AddAll · ${BUILD_MODE === 'dev' ? 'dev' : 'build'} ${BUILD_LABEL}`;
}

/** Só deixamos abrir externamente URLs http(s); nada de file:, javascript: etc. */
function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Popups do webview (window.open, target=_blank, links do jogo que abrem janela).
 *
 * O evento `new-window` do <webview> foi removido do Electron a partir da versão 22,
 * então o tratamento precisa ficar aqui, no processo principal. Em vez de abrir uma
 * janela nova, avisamos o renderer, que carrega a URL no próprio webview.
 */
const APP_SHORTCUT_KEYS = new Set(['k', 'j', ',']);

function attachWebviewHandlers(webviewContents: WebContents) {
  webviewContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.WEBVIEW_OPEN_URL, url);
    }
    return { action: 'deny' };
  });

  // Atalhos do app (Ctrl+K URL, Ctrl+J painel, Ctrl+, addons) valem mesmo com o foco no jogo:
  // o teclado do webview não chega ao documento do app, então interceptamos aqui.
  webviewContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const key = input.key.toLowerCase();
    if (!APP_SHORTCUT_KEYS.has(key)) return;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.APP_SHORTCUT, key);
  });
}

/** Salva posição/tamanho/maximizado da janela para restaurar na próxima abertura. */
function rememberWindowState(win: BrowserWindow) {
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // Quando maximizada, getBounds() devolve a tela inteira; guardamos os bounds "normais".
    const bounds = maximized ? windowStore.get().bounds : win.getBounds();
    windowStore.set({ bounds, maximized });
  };
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 300);
  };
  win.on('resize', debounced);
  win.on('move', debounced);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('close', save);
}

function createWindow() {
  const saved = windowStore.get();

  mainWindow = new BrowserWindow({
    width: saved.bounds?.width ?? 1400,
    height: saved.bounds?.height ?? 900,
    x: saved.bounds?.x,
    y: saved.bounds?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: windowTitle(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // o preload importa módulo compartilhado (require); manter false até bundlar o preload
      webviewTag: true,
      webSecurity: true,
    },
  });

  // O <title> do index.html sobrescreveria o título com a marca do build: mantemos o nosso.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(windowTitle());
  });

  // Popups da própria interface (não do webview): abre no navegador do sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Cada <webview> criado pela interface passa por aqui ao ser anexado.
  mainWindow.webContents.on('did-attach-webview', (_event, webviewContents) => {
    attachWebviewHandlers(webviewContents);
  });

  const distFile = path.join(__dirname, '../../dist/index.html');
  if (fs.existsSync(distFile)) {
    void mainWindow.loadFile(distFile);
  } else {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    if (saved.maximized || !saved.bounds) mainWindow.maximize();
    mainWindow.show();
    rememberWindowState(mainWindow);
    const open = process.env.HABBLET_OPEN;
    if (open) {
      // Reenvia algumas vezes: o renderer pode ainda não ter registrado o listener no primeiro disparo.
      const key = open === 'dock' ? 'j' : open.startsWith('addons') ? 'open:' + open.slice('addons:'.length) : open.startsWith('tab:') ? open : null;
      if (key) {
        for (const delay of key === 'j' ? [2000] : [1500, 3500, 6000]) {
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.APP_SHORTCUT, key);
          }, delay);
        }
      }
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------ Perfis (exportar/importar) ------------------------------ */

const PROFILE_FILTERS = [{ name: 'Perfil Habblet AddAll', extensions: ['json'] }];

async function exportProfile(): Promise<ProfileFileResult> {
  const win = mainWindow ?? undefined;
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win!, {
    title: 'Exportar perfil de configurações',
    defaultPath: `habblet-addall-perfil-${stamp}.json`,
    filters: PROFILE_FILTERS,
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };
  try {
    const settings = settingsStore.get();
    await fs.promises.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf8');
    return { ok: true, path: filePath, settings };
  } catch (e) {
    return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function importProfile(): Promise<ProfileFileResult> {
  const win = mainWindow ?? undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
    title: 'Importar perfil de configurações',
    filters: PROFILE_FILTERS,
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { ok: false, cancelled: true };
  const filePath = filePaths[0];
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !('addons' in parsed)) {
      return { ok: false, cancelled: false, error: 'O arquivo não parece ser um perfil do Habblet AddAll.' };
    }
    // Um perfil traz só configuração (addons + layout). Ativação dos addons e última URL são estado
    // de execução e ficam como estão.
    const { addons, ui, protocol } = parsed as { addons?: unknown; ui?: unknown; protocol?: unknown };
    const settings = settingsStore.update({ addons, ui, protocol } as SettingsPatch);
    return { ok: true, path: filePath, settings };
  } catch (e) {
    return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* -------------------------------------- IPC -------------------------------------- */

function registerIpc() {
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());

  ipcMain.handle(IPC.SHELL_OPEN_EXTERNAL, async (_event, url: unknown) => {
    if (typeof url !== 'string' || !isHttpUrl(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.WEBVIEW_GET_PRELOAD, () => pathToFileURL(path.join(__dirname, 'webview-preload.js')).href);

  ipcMain.handle(IPC.SETTINGS_GET, () => settingsStore.get());
  ipcMain.handle(IPC.SETTINGS_UPDATE, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) return settingsStore.get();
    return settingsStore.update(patch as SettingsPatch);
  });
  ipcMain.handle(IPC.SETTINGS_RESET, () => settingsStore.reset());
  ipcMain.handle(IPC.SETTINGS_EXPORT, () => exportProfile());
  ipcMain.handle(IPC.SETTINGS_IMPORT, () => importProfile());

  ipcMain.handle(IPC.GAME_FURNIDATA_GET, (_event, force: unknown) => getFurniCatalog(force === true));
}

const captureRecorder = new CaptureRecorder();

/**
 * Uma instância por pasta de dados. Sem isto, abrir o executável de `release/` com o `npm run dev` já
 * aberto (ou dois executáveis de builds diferentes) põe dois apps gravando o MESMO `config.json` e
 * `crowd.json`: o último a escrever ganha e as contas/configurações do outro somem. A trava do Electron
 * é por `userData`, então a instância de teste com `HABBLET_USER_DATA` continua abrindo normalmente.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Alguém tentou abrir outro: traz o que já está aberto para a frente em vez de duplicar.
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    appLog('app', 'outra instância foi aberta nesta pasta de dados; a janela atual foi trazida à frente.');
  });

  enableChromiumLog();

  app.whenReady().then(() => {
    registerAppLog();
    appLog('app', `build ${BUILD_MODE} ${BUILD_LABEL} (${BUILD_TIME})`);
    registerIpc();
    registerCrowdIpc(() => mainWindow);
    captureRecorder.start();
    createWindow();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => headless.disposeAll());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
