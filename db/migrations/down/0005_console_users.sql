-- Down da 0005. PERDE todos os usuários e sessões do console. As senhas são hash scrypt: não há
-- como recuperá-las. Depois disto ninguém entra no console até `npm run job -- console-user`.
drop table if exists console_sessions;
drop table if exists console_users;
