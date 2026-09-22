/// <reference types="vite/client" />

import type { HabbletApi } from '../shared/ipc';

declare global {
  interface Window {
    /** API exposta pelo preload do Electron (ver electron/preload.ts). */
    habblet: HabbletApi;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean;
          preload?: string;
          webpreferences?: string;
        },
        HTMLElement
      >;
    }
  }
}
