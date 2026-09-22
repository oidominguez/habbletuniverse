import { crowdPartition, HABBLET_HOME_URL } from '../../shared/crowd';
import type { CrowdManager, CrowdWebview } from './CrowdManager';

/**
 * Cria e gerencia os <webview> das contas da Multidão de forma IMPERATIVA (createElement), em vez
 * de deixar o React montá-los no JSX.
 *
 * Por quê: testado em 13/09/2026, um <webview> montado pelo React sobre habblet.city cai no desafio
 * cheio do Cloudflare ("Um momento…"), enquanto um <webview> idêntico criado por createElement (mesma
 * partition, preload, user agent) entra direto no site com o Turnstile passando sozinho. A reconciliação
 * do React sobre o elemento nativo (o ref recriado a cada render reanexa o guest ~4x/s por causa do
 * polling do snapshot) é o que denuncia a sessão. Criando os guests à mão e só trocando o CSS de posição
 * para mostrar um por vez (nunca reparentando), a sessão nunca recarrega e o Cloudflare não escala.
 */
export class CrowdGuestHost {
  private host: HTMLElement | null = null;
  private readonly guests = new Map<string, HTMLElement>();

  constructor(
    private readonly crowd: CrowdManager,
    private preload: string | null,
  ) {}

  setHost(el: HTMLElement | null): void {
    if (this.host === el) return;
    this.host = el;
    // Reancora os guests já criados no novo host (sem removê-los do DOM entre um e outro, o que
    // recarregaria o jogo). Na prática o host é estável durante toda a vida do app.
    if (el) for (const g of this.guests.values()) if (g.parentElement !== el) el.appendChild(g);
  }

  setPreload(preload: string | null): void {
    this.preload = preload;
  }

  /** Garante um guest por conta conectada e mostra só o selecionado. */
  sync(connectedIds: string[], selectedId: string | null): void {
    // Sem preload não há agente nem hook do Turnstile: um guest criado assim ficaria "surdo" para sempre
    // (o preload só vale na criação). Espera o caminho chegar; o App chama sync de novo quando ele existir.
    if (!this.host || !this.preload) return;
    const connected = new Set(connectedIds);

    for (const [id, el] of this.guests) {
      if (connected.has(id)) continue;
      this.crowd.attachWebview(id, null);
      el.remove();
      this.guests.delete(id);
    }

    for (const id of connectedIds) {
      if (this.guests.has(id)) continue;
      const el = document.createElement('webview');
      // partition/preload precisam existir ANTES de anexar (o guest anexa ao ser inserido no DOM).
      el.setAttribute('partition', crowdPartition(id));
      if (this.preload) el.setAttribute('preload', this.preload);
      el.setAttribute('allowpopups', '');
      el.setAttribute('webpreferences', 'sandbox=no');
      // src ANTES de anexar: a navegação inicial já parte direto para o site. Testado em 13/09/2026,
      // anexar sem src (about:blank) e só depois trocar o src faz o Cloudflare escalar para o desafio
      // cheio ("Um momento…"); indo direto para o site na primeira navegação, o Turnstile passa sozinho.
      el.setAttribute('src', HABBLET_HOME_URL);
      el.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0;background:#000';
      this.host.appendChild(el);
      // Listeners logo após anexar (antes do did-stop-loading disparar, que só vem quando a rede termina).
      this.crowd.attachWebview(id, el as unknown as CrowdWebview);
      this.guests.set(id, el);
    }

    for (const [id, el] of this.guests) {
      const visible = id === selectedId;
      el.style.left = visible ? '0' : '-20000px';
      el.style.zIndex = visible ? '2' : '0';
    }
  }

  dispose(): void {
    for (const [id, el] of this.guests) {
      this.crowd.attachWebview(id, null);
      el.remove();
    }
    this.guests.clear();
  }
}
