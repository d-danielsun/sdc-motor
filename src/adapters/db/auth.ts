// Persistência do login do console. O núcleo (src/core/auth.ts) faz a criptografia e não
// conhece banco; aqui é só SQL.
//
// Invariante: o token cru do cookie NUNCA chega ao banco — só o sha256 dele.
import type pg from "pg";
import { hashToken, novaSessao } from "../../core/auth.js";

export interface ConsoleUser { id: number; email: string; name: string; active: boolean }
export interface SessaoResolvida { tokenHash: string; user: ConsoleUser; expiresAt: Date }

type Db = Pick<pg.Pool, "query">;

export interface AuthStore {
  /** Usuário pelo e-mail normalizado, com o hash da senha (só o login usa o hash). */
  porEmail(email: string): Promise<(ConsoleUser & { passwordHash: string }) | null>;
  criarOuAtualizar(u: { email: string; name: string; passwordHash: string }): Promise<ConsoleUser>;
  definirSenha(email: string, passwordHash: string): Promise<ConsoleUser | null>;
  definirAtivo(email: string, active: boolean): Promise<ConsoleUser | null>;
  marcarLogin(userId: number, quando: Date): Promise<void>;
  listar(): Promise<Array<ConsoleUser & { lastLoginAt: Date | null }>>;

  abrirSessao(userId: number, agora: Date, ttlSegundos?: number): Promise<{ token: string; expiresAt: Date }>;
  /** Resolve o token do cookie. Sessão expirada ou de usuário desativado devolve null. */
  resolverSessao(token: string, agora: Date): Promise<SessaoResolvida | null>;
  fecharSessao(token: string): Promise<void>;
  revogarDoUsuario(userId: number): Promise<number>;
  purgarExpiradas(agora: Date): Promise<number>;
}

const USER_COLS = "id, email, name, active";
const linha = (r: Record<string, unknown>): ConsoleUser => ({ id: Number(r.id), email: String(r.email), name: String(r.name), active: r.active === true });

export function createAuthStore(db: Db): AuthStore {
  return {
    async porEmail(email) {
      const { rows } = await db.query(`select ${USER_COLS}, password_hash from console_users where email = $1`, [email]);
      const r = rows[0];
      return r ? { ...linha(r), passwordHash: String(r.password_hash) } : null;
    },

    async criarOuAtualizar(u) {
      // Reativa de propósito: `console-user` no mesmo e-mail é "esta pessoa deve poder entrar".
      const { rows } = await db.query(
        `insert into console_users (email, name, password_hash) values ($1, $2, $3)
         on conflict (email) do update set name = excluded.name, password_hash = excluded.password_hash, active = true
         returning ${USER_COLS}`,
        [u.email, u.name, u.passwordHash],
      );
      return linha(rows[0] as Record<string, unknown>);
    },

    async definirSenha(email, passwordHash) {
      const { rows } = await db.query(`update console_users set password_hash = $2 where email = $1 returning ${USER_COLS}`, [email, passwordHash]);
      return rows[0] ? linha(rows[0]) : null;
    },

    async definirAtivo(email, active) {
      const { rows } = await db.query(`update console_users set active = $2 where email = $1 returning ${USER_COLS}`, [email, active]);
      return rows[0] ? linha(rows[0]) : null;
    },

    async marcarLogin(userId, quando) {
      await db.query("update console_users set last_login_at = $2 where id = $1", [userId, quando]);
    },

    async listar() {
      const { rows } = await db.query(`select ${USER_COLS}, last_login_at from console_users order by email`);
      return rows.map((r) => ({ ...linha(r), lastLoginAt: r.last_login_at ? new Date(String(r.last_login_at)) : null }));
    },

    async abrirSessao(userId, agora, ttlSegundos) {
      const s = novaSessao(agora, ttlSegundos);
      await db.query("insert into console_sessions (token_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)", [s.tokenHash, userId, agora, s.expiresAt]);
      return { token: s.token, expiresAt: s.expiresAt };
    },

    async resolverSessao(token, agora) {
      // Um join só: sessão viva E usuário ativo. Desativar alguém corta na requisição seguinte,
      // sem precisar apagar sessão (e o CLI apaga de todo jeito).
      const { rows } = await db.query(
        `select s.token_hash, s.expires_at, u.id, u.email, u.name, u.active
           from console_sessions s join console_users u on u.id = s.user_id
          where s.token_hash = $1 and s.expires_at > $2 and u.active`,
        [hashToken(token), agora],
      );
      const r = rows[0];
      if (!r) return null;
      return { tokenHash: String(r.token_hash), user: linha(r), expiresAt: new Date(String(r.expires_at)) };
    },

    async fecharSessao(token) {
      await db.query("delete from console_sessions where token_hash = $1", [hashToken(token)]);
    },

    async revogarDoUsuario(userId) {
      const { rowCount } = await db.query("delete from console_sessions where user_id = $1", [userId]);
      return rowCount ?? 0;
    },

    async purgarExpiradas(agora) {
      const { rowCount } = await db.query("delete from console_sessions where expires_at <= $1", [agora]);
      return rowCount ?? 0;
    },
  };
}
