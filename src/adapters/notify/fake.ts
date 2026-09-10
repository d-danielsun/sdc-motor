// Notifier em memória para os testes: guarda o que teria sido enviado, e sabe falhar quando
// o teste quer exercitar o caminho de erro.
import type { Notifier } from "../../core/ports.js";

export interface AlertaEnviado { assunto: string; corpo: string; link: string | null }

export class FakeNotifier implements Notifier {
  readonly canal = "fake";
  enviados: AlertaEnviado[] = [];
  /** Quando setado, `entregar` lança com esta mensagem — simula o Resend fora do ar. */
  falharCom: string | null = null;

  constructor(public destinatarios: string[] = ["financeiro@exemplo.com.br"]) {}

  async entregar(a: AlertaEnviado): Promise<void> {
    if (this.falharCom) throw new Error(this.falharCom);
    this.enviados.push({ ...a });
  }
  get ultimo(): AlertaEnviado | undefined { return this.enviados[this.enviados.length - 1]; }
}
