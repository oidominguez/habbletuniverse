import { describe, expect, it } from 'vitest';
import { logSource } from '../src/components/logSource';

describe('logSource', () => {
  it('classifica pelo prefixo entre colchetes', () => {
    expect(logSource('Pedido de amizade enviado (protocolo): Wzzer (id 1).')).toBe('addons');
    expect(logSource('[Auto Message] enviado: :sit')).toBe('addons');
    expect(logSource('[Sussurros] respondi a Ana')).toBe('addons');
    expect(logSource('[CT] limpando console')).toBe('addons');
    expect(logSource('[Belmond] proxy aplicado: http://x:1 (só para o jogo)')).toBe('crowd');
    expect(logSource('[multidão] furnidata: 37022 mobis')).toBe('crowd');
    expect(logSource('[Colar quarto] lendo inventário')).toBe('paste');
    expect(logSource('[app] encerrando')).toBe('system');
  });
});
