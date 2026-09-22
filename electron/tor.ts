import { app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { TorSettings, TorStatus } from '../shared/crowd';

/**
 * Modo Tor (grátis): dá a cada conta da Multidão um IP de saída diferente.
 *
 * Detalhe crucial: o Chromium NÃO envia autenticação SOCKS5, então o truque de "usuário diferente
 * por conta" (IsolateSOCKSAuth) não funciona por aqui. O que funciona é o Tor abrir UMA porta SOCKS
 * por conta — o Tor isola circuitos por porta. Então geramos um torrc com N SocksPort (basePort,
 * basePort+1, …) e cada conta usa `socks5://127.0.0.1:<porta>`.
 *
 * Limites honestos: o Cloudflare marca saída Tor (toda conta cai no captcha → precisa do resolvedor
 * ou clique), é lento, e o Habblet pode bloquear nós de saída. Serve para teste, não para uso sério.
 */

let torProc: ChildProcess | null = null;
let lastError: string | null = null;

/** URL do proxy da conta de índice `i` (0-based) no modo Tor. */
export function torProxyUrl(s: TorSettings, index: number): string {
  return `socks5://${s.host}:${s.basePort + index}`;
}

/**
 * Acha o tor.exe automaticamente: primeiro o caminho informado, senão o `tor` do PATH, senão os
 * locais comuns do Tor Browser e do Tor Expert Bundle. Devolve o caminho utilizável ou null.
 */
export function detectTorExe(explicit?: string | null): string | null {
  const trimmed = explicit?.trim();
  if (trimmed) return existsSync(trimmed) ? trimmed : trimmed; // respeita o que o usuário informou
  const home = homedir();
  const candidates = [
    join(home, 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
    join(home, 'Downloads', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe'),
    join(home, 'Desktop', 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'PluggableTransports', 'tor.exe'),
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Tor Browser', 'Browser', 'TorBrowser', 'Tor', 'tor.exe') : '',
    join(home, 'Desktop', 'Tor', 'tor', 'tor.exe'), // Tor Expert Bundle
    join(home, 'Downloads', 'tor', 'tor.exe'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function torrcPath(): string {
  return join(app.getPath('userData'), 'tor', 'torrc');
}

/** Arquivos GeoIP ao lado do tor.exe (evita avisos ao rodar o tor do Tor Browser standalone). */
function geoipFor(exe: string): { geoip?: string; geoip6?: string } {
  const dataTor = join(dirname(dirname(exe)), 'Data', 'Tor'); // ...\TorBrowser\Data\Tor
  const geoip = join(dataTor, 'geoip');
  const geoip6 = join(dataTor, 'geoip6');
  return { geoip: existsSync(geoip) ? geoip : undefined, geoip6: existsSync(geoip6) ? geoip6 : undefined };
}

function torDataDir(): string {
  return join(app.getPath('userData'), 'tor', 'data');
}

/** Escreve um torrc com uma SocksPort por conta e devolve o caminho. */
export function generateTorrc(s: TorSettings): { path: string; ports: number[] } {
  const ports: number[] = [];
  const lines = [
    '# Gerado pelo Habblet AddAll — uma SocksPort por conta (isolamento de circuito por porta).',
    `DataDirectory ${torDataDir()}`,
  ];
  for (let i = 0; i < s.count; i++) {
    const port = s.basePort + i;
    ports.push(port);
    // IsolateDestAddr/IsolateDestPort reforçam circuitos distintos por porta.
    lines.push(`SocksPort ${s.host}:${port} IsolateDestAddr IsolateDestPort`);
  }
  const path = torrcPath();
  mkdirSync(join(app.getPath('userData'), 'tor'), { recursive: true });
  mkdirSync(torDataDir(), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', 'utf-8');
  return { path, ports };
}

export function torStatus(settings?: TorSettings): TorStatus {
  return { running: !!torProc && torProc.exitCode === null, torrcPath: torrcPath(), error: lastError, torExe: detectTorExe(settings?.torExePath) };
}

/** Sobe o processo do Tor com o torrc gerado. `torExePath` vazio tenta o `tor` do PATH. */
export function launchTor(s: TorSettings): TorStatus {
  if (torProc && torProc.exitCode === null) return torStatus();
  lastError = null;
  const { path } = generateTorrc(s);
  const exe = detectTorExe(s.torExePath) ?? 'tor';
  // Se achamos o tor.exe do Tor Browser, passamos os GeoIP dele para evitar avisos.
  const geo = exe.toLowerCase().endsWith('tor.exe') && exe.includes('TorBrowser') ? geoipFor(exe) : {};
  const args = ['-f', path];
  if (geo.geoip) args.push('GeoIPFile', geo.geoip);
  if (geo.geoip6) args.push('GeoIPv6File', geo.geoip6);
  try {
    torProc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    torProc.on('error', (e) => { lastError = e.message.includes('ENOENT') ? `não encontrei o tor.exe. Instale o Tor Browser ou informe o caminho do tor.exe no campo.` : e.message; torProc = null; });
    torProc.on('exit', (code) => { if (code && code !== 0) lastError = `Tor saiu com código ${code}`; torProc = null; });
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    torProc = null;
  }
  return torStatus();
}

export function stopTor(): TorStatus {
  if (torProc && torProc.exitCode === null) torProc.kill();
  torProc = null;
  return torStatus();
}

/** Encerra o Tor ao fechar o app. */
app.on('before-quit', () => { if (torProc && torProc.exitCode === null) torProc.kill(); });
