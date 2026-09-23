import { describe, expect, it } from 'vitest';
import { COMMAND_SPECS, describeCommand, parseCrowdCommand, suggestCommands } from '../src/crowd/commandParser';
import type { CrowdCommand } from '../src/crowd/CrowdManager';

const parse = (s: string): CrowdCommand => {
  const r = parseCrowdCommand(s);
  if (!r.ok) throw new Error(r.error);
  return r.command;
};

describe('parseCrowdCommand', () => {
  it('texto sem verbo é fala; texto com ":" é comando de chat do servidor, também como fala', () => {
    expect(parse('oi gente')).toEqual({ kind: 'chat', text: 'oi gente' });
    expect(parse(':sit')).toEqual({ kind: 'chat', text: ':sit' });
    expect(parse('  :dance 2 ')).toEqual({ kind: 'chat', text: ':dance 2' });
    expect(parse('falar ir embora')).toEqual({ kind: 'chat', text: 'ir embora' });
  });

  it('cobre cada comando da Multidão por um verbo', () => {
    expect(parse('gritar OI')).toEqual({ kind: 'shout', text: 'OI' });
    expect(parse('sussurrar Dominguez vem cá agora')).toEqual({ kind: 'whisper', nick: 'Dominguez', text: 'vem cá agora' });
    expect(parse('console Belmond bom dia')).toEqual({ kind: 'console', name: 'Belmond', text: 'bom dia' });
    expect(parse('ir até Dominguez')).toEqual({ kind: 'goTo', name: 'Dominguez' });
    expect(parse('ir Dominguez')).toEqual({ kind: 'goTo', name: 'Dominguez' });
    expect(parse('fixar Dominguez')).toEqual({ kind: 'pin', name: 'Dominguez' });
    expect(parse('soltar')).toEqual({ kind: 'unpin' });
    expect(parse('andar 12 7')).toEqual({ kind: 'walk', x: 12, y: 7 });
    expect(parse('olhar 3 4')).toEqual({ kind: 'look', x: 3, y: 4 });
    expect(parse('clicar Wzzer')).toEqual({ kind: 'clickUser', name: 'Wzzer' });
    expect(parse('entrar 7078217')).toEqual({ kind: 'enterRoom', roomId: 7078217 });
    expect(parse('seguir Dominguez')).toEqual({ kind: 'followFriend', name: 'Dominguez' });
    expect(parse('grupo 1234')).toEqual({ kind: 'joinGroup', groupId: 1234 });
    expect(parse('nota')).toEqual({ kind: 'rateRoom' });
    expect(parse('amizade kehlaree')).toEqual({ kind: 'requestFriend', name: 'kehlaree' });
    expect(parse('aceitar')).toEqual({ kind: 'acceptPending' });
    expect(parse('respeitar Dominguez')).toEqual({ kind: 'respect', name: 'Dominguez' });
    expect(parse('convidar')).toEqual({ kind: 'inviteFriends', message: 'Vem pro quarto!', onlineOnly: true });
    expect(parse('convidar todos festa agora')).toEqual({ kind: 'inviteFriends', message: 'festa agora', onlineOnly: false });
    expect(parse('sentar')).toEqual({ kind: 'posture', posture: 'sit' });
    expect(parse('deitar')).toEqual({ kind: 'posture', posture: 'lay' });
    expect(parse('levantar')).toEqual({ kind: 'standUp' });
    expect(parse('parar')).toEqual({ kind: 'cancelPosture' });
    expect(parse('visual Dominguez')).toEqual({ kind: 'copyLook', name: 'Dominguez' });
    expect(parse('aplicar hd-180-1.hr-828-61')).toEqual({ kind: 'setLook', figure: 'hd-180-1.hr-828-61' });
  });

  it('aceita sinônimos e ignora caixa e espaços extras', () => {
    expect(parse('Pedir   kehlaree')).toEqual({ kind: 'requestFriend', name: 'kehlaree' });
    expect(parse('SIT')).toEqual({ kind: 'posture', posture: 'sit' });
    expect(parse('whisper Ana oi')).toEqual({ kind: 'whisper', nick: 'Ana', text: 'oi' });
  });

  it('reclama de argumento faltando ou inválido, sem executar nada', () => {
    expect(parseCrowdCommand('')).toEqual({ ok: false, error: 'Digite um comando ou uma frase.' });
    expect(parseCrowdCommand('sussurrar Ana')).toMatchObject({ ok: false, error: 'sussurrar <nick> <texto>' });
    expect(parseCrowdCommand('andar 12 x')).toMatchObject({ ok: false, error: 'andar <x> <y>' });
    expect(parseCrowdCommand('entrar abc')).toMatchObject({ ok: false, error: 'entrar <id do quarto>' });
    expect(parseCrowdCommand('fixar')).toMatchObject({ ok: false });
  });

  it('todo comando tem descrição', () => {
    for (const s of COMMAND_SPECS) {
      const r = s.build(['Nick', 'texto', '1', '2'], 'Nick texto 1 2');
      if (typeof r !== 'string') expect(describeCommand(r)).toBeTruthy();
    }
  });
});

describe('suggestCommands', () => {
  it('lista verbos pelo prefixo e, com ":", os comandos do servidor', () => {
    expect(suggestCommands('se').map((s) => s.label)).toEqual(['seguir <nick>', 'sentar']);
    expect(suggestCommands('con').map((s) => s.spec?.verb)).toEqual(['console', 'convidar']);
    expect(suggestCommands(':d', [':sit', ':dance', ':empty']).map((s) => s.label)).toEqual([':dance']);
    expect(suggestCommands(':', [':sit', ':dance']).length).toBe(2);
  });

  it('com o verbo completo e argumentos, só lembra a assinatura; texto livre não sugere nada', () => {
    expect(suggestCommands('sussurrar Ana').map((s) => s.label)).toEqual(['sussurrar <nick> <texto>']);
    expect(suggestCommands('oi gente')).toEqual([]);
    expect(suggestCommands('').length).toBe(8);
  });
});
