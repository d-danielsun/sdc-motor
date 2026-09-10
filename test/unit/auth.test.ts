// Criptografia e freio do login, sem banco. O que este arquivo protege: senha guardada de um
// jeito que não volta, token de cookie que nunca é o que está no banco, e um freio que conta
// por e-mail E por IP.
import { describe, expect, it } from "vitest";
import {
  FreioDeLogin, LOGIN_MAX_TENTATIVAS, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, SESSION_TTL_SECONDS,
  SenhaInvalida, assertSenhaAceitavel, gerarSenha, hashPassword, hashToken, isEmail, normalizeEmail,
  novaSessao, tokenBemFormado, verifyPassword,
} from "../../src/core/auth.js";

describe("senha", () => {
  it("hash confere com a senha certa e recusa a errada", async () => {
    const h = await hashPassword("uma-senha-boa-1");
    expect(await verifyPassword("uma-senha-boa-1", h)).toBe(true);
    expect(await verifyPassword("uma-senha-boa-2", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });
  it("o hash carrega os próprios parâmetros e nunca repete o salt", async () => {
    const a = await hashPassword("uma-senha-boa-1");
    const b = await hashPassword("uma-senha-boa-1");
    expect(a).not.toBe(b);                       // salt diferente
    expect(a.split("$")[0]).toBe("scrypt");
    expect(a.split("$").length).toBe(6);         // scrypt$N$r$p$salt$hash
    expect(a).not.toContain("uma-senha-boa-1");  // o óbvio, dito por teste
    // e um hash antigo continua conferindo mesmo se o custo padrão mudar depois
    expect(await verifyPassword("uma-senha-boa-1", b)).toBe(true);
  });
  it("hash malformado devolve false em vez de estourar", async () => {
    for (const lixo of ["", "x", "scrypt$", "scrypt$a$b$c$d$e", "bcrypt$16384$8$1$AA==$AA==", "scrypt$16384$8$1$$", "scrypt$99999999$8$1$AA==$AA==", "scrypt$16384$8$1$@@@$@@@"]) {
      expect(await verifyPassword("qualquer", lixo), lixo).toBe(false);
    }
  });
  it("normaliza unicode: a mesma senha digitada de dois jeitos entra", async () => {
    const composta = "senha-café-longa";          // café com "é" pronto
    const decomposta = "senha-café-longa";       // e + acento combinante
    expect(composta).not.toBe(decomposta);
    expect(await verifyPassword(decomposta, await hashPassword(composta))).toBe(true);
  });
  it("recusa senha curta demais e longa demais em vez de truncar", async () => {
    expect(() => assertSenhaAceitavel("x".repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(SenhaInvalida);
    expect(() => assertSenhaAceitavel("x".repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(SenhaInvalida);
    expect(() => assertSenhaAceitavel("x".repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
    // e senha absurda não vira igual à sua versão cortada
    const h = await hashPassword("y".repeat(MAX_PASSWORD_LENGTH));
    expect(await verifyPassword("y".repeat(MAX_PASSWORD_LENGTH + 1), h)).toBe(false);
  });
  it("a senha gerada é longa, sem caractere ambíguo e nunca igual à anterior", () => {
    const vistas = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = gerarSenha();
      expect(s).toMatch(/^[a-zA-Z2-9-]{20,}$/);
      expect(s).not.toMatch(/[l1O0]/);
      expect(() => assertSenhaAceitavel(s)).not.toThrow();
      vistas.add(s);
    }
    expect(vistas.size).toBe(50);
  });
});

describe("sessão", () => {
  it("o token do cookie NÃO é o que vai para o banco", () => {
    const s = novaSessao(new Date("2026-09-10T12:00:00Z"));
    expect(s.tokenHash).not.toBe(s.token);
    expect(s.tokenHash).toBe(hashToken(s.token));
    expect(s.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.token.length).toBeGreaterThanOrEqual(40);
  });
  it("expira no TTL, contado do momento de criação", () => {
    const agora = new Date("2026-09-10T12:00:00Z");
    expect(novaSessao(agora).expiresAt.getTime() - agora.getTime()).toBe(SESSION_TTL_SECONDS * 1000);
    expect(novaSessao(agora, 60).expiresAt.toISOString()).toBe("2026-09-10T12:01:00.000Z");
  });
  it("token nunca se repete", () => {
    const vistos = new Set(Array.from({ length: 200 }, () => novaSessao(new Date()).token));
    expect(vistos.size).toBe(200);
  });
  it("formato do token é checado antes de ir ao banco", () => {
    expect(tokenBemFormado(novaSessao(new Date()).token)).toBe(true);
    for (const ruim of [null, undefined, "", "curto", "x".repeat(65), "tem espaço aqui dentro!!", "'; drop table console_sessions; --"]) {
      expect(tokenBemFormado(ruim), String(ruim)).toBe(false);
    }
  });
});

describe("e-mail", () => {
  it("normaliza para o que o unique do banco enxerga", () => {
    expect(normalizeEmail("  Financeiro@Exemplo.COM.BR ")).toBe("financeiro@exemplo.com.br");
  });
  it("aceita e-mail plausível e recusa o resto", () => {
    for (const bom of ["a@b.co", "financeiro@exemplo.com.br", "nome+tag@exemplo.com"]) expect(isEmail(bom), bom).toBe(true);
    for (const ruim of ["", "sem-arroba", "a@b", "a@@b.co", "a b@c.co", `${"x".repeat(250)}@exemplo.com.br`]) expect(isEmail(ruim), ruim).toBe(false);
  });
});

describe("freio de tentativas", () => {
  const t = (ms: number) => new Date(1_700_000_000_000 + ms);
  it("solta até o limite e barra a partir dele", () => {
    const f = new FreioDeLogin();
    for (let i = 0; i < LOGIN_MAX_TENTATIVAS; i++) {
      expect(f.bloqueado(["email:a"], t(i)), `tentativa ${i + 1}`).toBe(false);
      f.registrarFalha(["email:a"], t(i));
    }
    expect(f.bloqueado(["email:a"], t(10))).toBe(true);   // a 6ª bate
  });
  it("conta por IP também: varrer e-mails de um IP só bate no limite do IP", () => {
    const f = new FreioDeLogin();
    for (let i = 0; i < LOGIN_MAX_TENTATIVAS; i++) f.registrarFalha([`email:vitima${i}`, "ip:1.2.3.4"], t(i));
    expect(f.bloqueado(["email:aindanaotentado", "ip:1.2.3.4"], t(10))).toBe(true);
    expect(f.bloqueado(["email:aindanaotentado", "ip:9.9.9.9"], t(10))).toBe(false);
  });
  it("a janela anda: tentativas velhas deixam de contar", () => {
    const f = new FreioDeLogin(2, 1000);
    f.registrarFalha(["email:a"], t(0));
    f.registrarFalha(["email:a"], t(500));
    expect(f.bloqueado(["email:a"], t(600))).toBe(true);
    expect(f.bloqueado(["email:a"], t(1600))).toBe(false);   // a primeira saiu da janela
  });
  it("login certo limpa o contador", () => {
    const f = new FreioDeLogin(2);
    f.registrarFalha(["email:a", "ip:x"], t(0));
    f.registrarFalha(["email:a", "ip:x"], t(1));
    expect(f.bloqueado(["email:a"], t(2))).toBe(true);
    f.limpar(["email:a", "ip:x"]);
    expect(f.bloqueado(["email:a", "ip:x"], t(3))).toBe(false);
  });
});
