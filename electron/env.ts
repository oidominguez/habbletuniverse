/**
 * Ajustes de ambiente que precisam acontecer ANTES de qualquer outro módulo do main
 * (o electron-store fixa o caminho em app.getPath('userData') ao ser importado).
 *
 * HABBLET_USER_DATA — pasta de dados alternativa: instância de teste isolada, sem tocar na
 * sessão real (store, cookies do webview, capturas).
 */
import { app } from 'electron';

if (process.env.HABBLET_USER_DATA) app.setPath('userData', process.env.HABBLET_USER_DATA);
