/** Formatação compartilhada pelos painéis (sem React). */

/** Nomes de quarto do Habblet usam espaços "invisíveis" para alinhar; colapsa tudo em um espaço. */
export function cleanName(name: string | null): string {
  return (name ?? '').replace(/[\u3164\u2000-\u200b\u00a0\s]+/g, ' ').trim();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** HH:MM:SS no fuso local. */
export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString('pt-BR', { hour12: false });
}

/** HH:MM:SS.mmm, para a captura de protocolo. */
export function fmtTimeMs(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString('pt-BR', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
