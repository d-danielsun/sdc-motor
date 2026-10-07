// BLOQ-1: todo ponto de entrada que roda jobs passa pela mesma checagem de boot do gateway.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("checagem de boot do gateway", () => {
  for (const f of ["src/app/main.ts", "src/cli/job.ts"]) {
    it(`${f} chama assertGatewayBoot`, () => {
      expect(readFileSync(f, "utf8")).toMatch(/await assertGatewayBoot\(deps\.gateway, deps\.repo\)/);
    });
  }
});
