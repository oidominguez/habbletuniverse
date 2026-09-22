import { describe, expect, it } from 'vitest';
import { PROBE_LOGIN_JS, PROBE_TURNSTILE_JS, RESUME_LOGIN_JS, buildLoginJs, buildSubmitWithTokenJs } from '../src/crowd/loginScript';

/** Os scripts rodam dentro da página via executeJavaScript: aqui garantimos que são JS válido e que carregam os dados certos. */
const parses = (src: string) => {
  // `new Function` compila sem executar; a expressão precisa ser sintaticamente válida.
  new Function('return (' + src + ');');
};

describe('scripts de login da Multidão', () => {
  it('todas as sondagens são JS válido', () => {
    for (const src of [PROBE_LOGIN_JS, PROBE_TURNSTILE_JS, RESUME_LOGIN_JS]) expect(() => parses(src)).not.toThrow();
  });

  it('buildLoginJs é JS válido, embute as credenciais escapadas e espera os campos aparecerem', () => {
    const js = buildLoginJs('Zé "Teste"', "se'nha\\x", 7000, 3000);
    expect(() => parses(js)).not.toThrow();
    expect(js).toContain(JSON.stringify('Zé "Teste"'));
    expect(js).toContain(JSON.stringify("se'nha\\x"));
    expect(js).toContain('waited < 7000'); // espera pelos campos
    expect(js).toContain('waited < 3000'); // espera pelo Turnstile
    expect(js).toContain("step: 'fields-timeout'");
    expect(js).toContain("step: 'fill-failed'");
  });

  it('buildSubmitWithTokenJs é JS válido e injeta o token', () => {
    const js = buildSubmitWithTokenJs('tok.en"123');
    expect(() => parses(js)).not.toThrow();
    expect(js).toContain(JSON.stringify('tok.en"123'));
  });
});
