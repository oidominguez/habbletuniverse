/**
 * Garante que o executável em `release/win-unpacked` é MESMO o build que acabou de ser compilado.
 *
 * Por que existe: com o app aberto a partir de `release/`, o Windows trava o `.exe` e as DLLs, o
 * electron-builder aborta ("Access is denied" ao limpar a pasta) e a pasta fica com o build ANTERIOR.
 * Quem não olhar a saída inteira acha que empacotou e sai testando um executável velho — foi o que
 * aconteceu em 21/09/2026. O `&&` do npm propaga a falha, mas basta um `| grep` na frente para o
 * código de saída sumir; esta checagem é por CONTEÚDO, então não depende de ninguém ler o log.
 *
 * Uso:
 *   node tools/verify-pack.mjs --pre   antes de empacotar: falha se a pasta estiver em uso
 *   node tools/verify-pack.mjs         depois: falha se o asar não contiver a marca deste build
 */
import { closeSync, existsSync, openSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'release', 'win-unpacked');
const asar = join(outDir, 'resources', 'app.asar');
const pre = process.argv.includes('--pre');

function die(msg) {
  console.error(`\n  ✖ ${msg}\n`);
  process.exit(1);
}

/** O arquivo está travado por um processo (app aberto)? */
function locked(file) {
  if (!existsSync(file)) return false;
  try {
    closeSync(openSync(file, 'r+'));
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

if (pre) {
  if (!existsSync(outDir)) process.exit(0); // primeira vez: não há o que travar
  const busy = ['Universe.exe', 'Habblet AddAll.exe', 'd3dcompiler_47.dll', 'ffmpeg.dll'].map((f) => join(outDir, f)).filter(locked);
  if (busy.length > 0) {
    die(
      'o app está aberto a partir de release/win-unpacked e trava os arquivos.\n' +
        '    Feche o "Universe" e rode de novo — senão o electron-builder aborta no meio e a\n' +
        '    pasta continua com o build ANTERIOR, e você testa uma versão velha sem perceber.',
    );
  }
  process.exit(0);
}

// Depois de empacotar: o asar tem de carregar a marca deste build.
if (!existsSync(asar)) die(`o empacotamento não gerou ${asar}.`);

const infoPath = join(root, 'shared', 'build-info.ts');
const info = readFileSync(infoPath, 'utf8');
const label = /BUILD_LABEL = '([^']+)'/.exec(info)?.[1];
if (!label) die(`não consegui ler BUILD_LABEL de ${infoPath}.`);

if (!readFileSync(asar).includes(Buffer.from(label, 'utf8'))) {
  die(
    `release/win-unpacked está DESATUALIZADO: o app.asar não contém a marca "${label}" deste build.\n` +
      '    O electron-builder não conseguiu substituir a pasta (o app estava aberto?).\n' +
      '    Feche o "Universe" e rode `npm run pack` de novo.',
  );
}

console.log(`verify-pack: release/win-unpacked confere com o build ${label}.`);
