// Material de teste do Itaú: CA, servidor e cliente gerados NA HORA em tmpdir (nada versionado),
// e um servidor HTTPS local que EXIGE certificado de cliente — o mTLS é exercitado de verdade.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

export interface Pki { ca: string; serverCert: string; serverKey: string; clientCert: string; clientKey: string; otherKey: string; shortCert: string; csr: string; dir: string; cleanup(): void }

export function gerarPki(): Pki {
  const dir = mkdtempSync(path.join(tmpdir(), "itau-pki-"));
  const p = (f: string) => path.join(dir, f);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=CA de teste");
  writeFileSync(p("srv.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost");
  ssl("x509", "-req", "-in", "srv.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "srv.crt", "-days", "2", "-extfile", "srv.ext");
  ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "cli.key", "-out", "cli.csr", "-subj", "/CN=client-id-teste/OU=SDC/L=SAO PAULO/ST=SP/C=BR");
  ssl("x509", "-req", "-in", "cli.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "cli.crt", "-days", "45");
  ssl("x509", "-req", "-in", "cli.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "short.crt", "-days", "10");
  ssl("genrsa", "-out", "other.key", "2048");
  const r = (f: string) => readFileSync(p(f), "utf8");
  return {
    ca: r("ca.crt"), serverCert: r("srv.crt"), serverKey: r("srv.key"), clientCert: r("cli.crt"), clientKey: r("cli.key"),
    otherKey: r("other.key"), shortCert: r("short.crt"), csr: r("cli.csr"), dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Pedido { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string; clientCn: string | null }
export type Rota = (req: Pedido) => { status: number; body: string; delayMs?: number };

/** Servidor HTTPS local. `exigirCliente` = mTLS obrigatório (como o STS). */
export async function servidorItau(pki: Pki, rota: Rota, o: { exigirCliente?: boolean } = {}) {
  const pedidos: Pedido[] = [];
  const exigir = o.exigirCliente ?? true;
  const srv = https.createServer({ key: pki.serverKey, cert: pki.serverCert, ca: pki.ca, requestCert: exigir, rejectUnauthorized: exigir }, (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      const peer = (req.socket as import("node:tls").TLSSocket).getPeerCertificate?.();
      const pedido: Pedido = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, clientCn: peer && peer.subject ? String(peer.subject.CN) : null };
      pedidos.push(pedido);
      const r = rota(pedido);
      setTimeout(() => { res.writeHead(r.status, { "content-type": "application/json" }); res.end(r.body); }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `https://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, pedidos, close: () => new Promise<void>((ok) => { srv.closeAllConnections(); srv.close(() => ok()); }) };
}
