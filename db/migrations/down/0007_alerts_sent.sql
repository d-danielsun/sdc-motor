-- Down da 0007. PERDE todo o histórico de alertas enviados — e com ele a janela de silêncio, então
-- o primeiro tick depois disso manda e-mail de cada condição ainda presente.
drop table if exists alerts_sent;
