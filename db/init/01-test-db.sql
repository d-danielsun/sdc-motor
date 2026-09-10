-- Bancos separados do de desenvolvimento. Só roda na 1ª inicialização do volume:
-- `npm run db:reset` recria do zero.
--   motor_test → suíte (test/db). A suíte trunca as tabelas a cada teste.
--   motor_demo → `npm run demo` (cenários de demonstração). O demo TRUNCA tudo ao começar.
create database motor_test;
create database motor_demo;
