/**
 * Gera `shared/build-info.ts` com a marca desta compilação.
 *
 * Roda sozinho no `npm run build` e no `npm run dev` (ver package.json). O objetivo é um só: olhando o
 * app, saber QUAL build está rodando — o título da janela, a marca do trilho e a primeira linha do log
 * do dia mostram a mesma etiqueta. Assim não dá para confundir o executável de `release/win-unpacked`
 * com o que está em desenvolvimento, nem rodar um `.exe` velho achando que tem as mudanças de agora.
 *
 * Uso: node tools/build-stamp.mjs [dev|build]
 */
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const mode = process.argv[2] === 'dev' ? 'dev' : 'build';
const now = new Date();
const p = (n) => String(n).padStart(2, '0');
/** Curto e comparável de relance, no fuso local: `21/09 10:14`. */
const label = `${p(now.getDate())}/${p(now.getMonth() + 1)} ${p(now.getHours())}:${p(now.getMinutes())}`;

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'build-info.ts');
const content = `/**
 * Marca desta compilação. GERADO por tools/build-stamp.mjs a cada \`npm run build\` / \`npm run dev\`;
 * não editar à mão (qualquer mudança é sobrescrita na próxima compilação).
 *
 * Aparece no título da janela, na marca do trilho esquerdo e na primeira linha do log do dia, para
 * não confundir o executável empacotado com o de desenvolvimento nem rodar um build velho por engano.
 */

/** Momento da compilação, em ISO (UTC). */
export const BUILD_TIME = '${now.toISOString()}';

/** Etiqueta curta no fuso local, do jeito que aparece na interface: \`${label}\`. */
export const BUILD_LABEL = '${label}';

/** \`dev\` = Vite com recarga; \`build\` = empacotado (dist / release). */
export const BUILD_MODE: 'dev' | 'build' = '${mode}';
`;

writeFileSync(file, content, 'utf8');
console.log(`build-stamp: ${mode} ${label} (${now.toISOString()})`);
