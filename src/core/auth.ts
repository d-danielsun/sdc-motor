// Autenticação do console: senha e sessão. Puro — nada de HTTP, banco ou env aqui.
// `node:crypto` é builtin de Node e do Deno, então o núcleo continua portátil.
//
// DUAS DECISÕES QUE VALEM LER:
// 1. A senha é derivada com scrypt e comparada em tempo constante. O formato guardado carrega
//    os próprios parâmetros (scrypt$N$r$p$salt$hash), então dá para endurecer o custo depois
//    sem invalidar as senhas antigas.
// 2. O token de sessão que vai no cookie nunca é persistido: o banco guarda o sha256. Quem
//    ler o banco não consegue se passar por ninguém.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (senha: string | Buffer, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem?: number }) => Promise<Buffer>;

export interface CustoScrypt { N: number; r: number; p: number }

/** Custo de produção: ~240 ms e 16 MB num laptop M-series (medido, não estimado). Cara o
 *  suficiente para força bruta doer, barata o suficiente para o login não parecer travado.
 *  maxmem tem que caber 128*N*r ou o node recusa. */
export const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32, saltBytes: 16 } as const;

/** Custo BARATO, só para teste. A suíte cria e confere dezenas de senhas; com o custo de
 *  produção ela levava minutos, e suíte lenta é suíte que ninguém roda. O formato do hash
 *  carrega os próprios parâmetros, então o mesmo `verifyPassword` confere os dois. */
export const CUSTO_TESTE: CustoScrypt = { N: 1024, r: 8, p: 1 };
const MAXMEM = 64 * 1024 * 1024;

export const SESSION_TTL_SECONDS = 12 * 60 * 60;   // 43200, o Max-Age do cookie
export const SESSION_TOKEN_BYTES = 32;
export const MIN_PASSWORD_LENGTH = 12;
/** Limite do scrypt de referência: senha maior que isso é recusada em vez de truncada. */
export const MAX_PASSWORD_LENGTH = 200;

export class SenhaInvalida extends Error {}

/** Normaliza o e-mail: o unique do banco vale sobre esta forma. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export function isEmail(v: string): boolean {
  const e = normalizeEmail(v);
  return e.length <= 254 && EMAIL_RE.test(e);
}

export function assertSenhaAceitavel(senha: string): void {
  if (senha.length < MIN_PASSWORD_LENGTH) throw new SenhaInvalida(`a senha precisa de pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
  if (senha.length > MAX_PASSWORD_LENGTH) throw new SenhaInvalida(`a senha passa de ${MAX_PASSWORD_LENGTH} caracteres`);
}

/** Deriva o hash de uma senha. Formato: scrypt$N$r$p$salt_b64$hash_b64 */
export async function hashPassword(senha: string, o: { salt?: Buffer; custo?: CustoScrypt } = {}): Promise<string> {
  assertSenhaAceitavel(senha);
  const { N, r, p } = o.custo ?? SCRYPT;
  const salt = o.salt ?? randomBytes(SCRYPT.saltBytes);
  const hash = await scrypt(senha.normalize("NFKC"), salt, SCRYPT.keylen, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Confere a senha contra o hash guardado. Nunca lança por hash malformado: devolve false. */
export async function verifyPassword(senha: string, guardado: string): Promise<boolean> {
  const p = guardado.split("$");
  if (p.length !== 6 || p[0] !== "scrypt") return false;
  const N = Number(p[1]), r = Number(p[2]), par = Number(p[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(par) || N < 1024 || r < 1 || par < 1 || N > 1 << 20) return false;
  let salt: Buffer, esperado: Buffer;
  try {
    salt = Buffer.from(p[4] as string, "base64");
    esperado = Buffer.from(p[5] as string, "base64");
  } catch { return false; }
  if (salt.length === 0 || esperado.length === 0) return false;
  if (senha.length > MAX_PASSWORD_LENGTH) return false;
  let obtido: Buffer;
  try {
    obtido = await scrypt(senha.normalize("NFKC"), salt, esperado.length, { N, r, p: par, maxmem: MAXMEM });
  } catch { return false; }
  return obtido.length === esperado.length && timingSafeEqual(obtido, esperado);
}

/** Senha aleatória legível para o CLI imprimir uma vez. Sem caracteres ambíguos (l/1/O/0). */
export function gerarSenha(grupos = 4): string {
  const alfabeto = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(grupos * 5);
  const pedacos: string[] = [];
  for (let g = 0; g < grupos; g++) {
    let s = "";
    for (let i = 0; i < 5; i++) s += alfabeto[(bytes[g * 5 + i] as number) % alfabeto.length];
    pedacos.push(s);
  }
  return pedacos.join("-");   // 20 caracteres de alfabeto 56 ≈ 116 bits
}

/** Token de sessão cru (vai no cookie, nunca no banco) + o hash que é persistido. */
export function novaSessao(agora: Date, ttlSegundos = SESSION_TTL_SECONDS): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token), expiresAt: new Date(agora.getTime() + ttlSegundos * 1000) };
}

export const hashToken = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

/** Formato do token do cookie, checado antes de ir ao banco (evita consulta com lixo). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const tokenBemFormado = (v: string | null | undefined): v is string => typeof v === "string" && TOKEN_RE.test(v);

// ── freio de tentativas ──────────────────────────────────────────────────────

export const LOGIN_MAX_TENTATIVAS = 5;          // a 6ª responde 429
export const LOGIN_JANELA_MS = 15 * 60 * 1000;

/** Contador em memória do processo (é um serviço só, e o issue #14 é quem leva isso pro banco).
 *  Conta por e-mail E por IP: quem varre e-mails de um IP só bate no limite do IP. */
export class FreioDeLogin {
  private tentativas = new Map<string, number[]>();
  constructor(private readonly max = LOGIN_MAX_TENTATIVAS, private readonly janelaMs = LOGIN_JANELA_MS) {}

  /** true = já passou do limite; não registra nada (a checagem é antes de tentar). */
  bloqueado(chaves: string[], agora: Date): boolean {
    return chaves.some((k) => this.recentes(k, agora).length >= this.max);
  }
  registrarFalha(chaves: string[], agora: Date): void {
    for (const k of chaves) this.tentativas.set(k, [...this.recentes(k, agora), agora.getTime()]);
  }
  limpar(chaves: string[]): void {
    for (const k of chaves) this.tentativas.delete(k);
  }
  private recentes(k: string, agora: Date): number[] {
    const lista = (this.tentativas.get(k) ?? []).filter((t) => agora.getTime() - t < this.janelaMs);
    if (lista.length === 0) this.tentativas.delete(k); else this.tentativas.set(k, lista);
    return lista;
  }
}
