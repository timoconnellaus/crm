// Suggested job changes in words, per signal.
import { describe, expect, it } from "vitest";
import { jobChangeEvidence } from "../src/components/suggestions/evidence.ts";

describe("jobChangeEvidence", () => {
  it("describes a bounce", () => {
    const out = jobChangeEvidence({
      signal: "bounce",
      evidence: { email: "ada@old.test", subject: "Catch up" },
      proposal: { endOnly: true },
    });
    expect(out).toEqual({ headline: "Mail to ada@old.test bounced", detail: "“Catch up”" });
  });

  it("describes a new signature with the proposed role", () => {
    const out = jobChangeEvidence({
      signal: "signature",
      evidence: { signature: "Ada\nCTO, Newco" },
      proposal: { organisationName: "Newco", title: "CTO" },
    });
    expect(out.headline).toBe("Their email signature changed: CTO at Newco");
    expect(out.detail).toBe("Ada\nCTO, Newco");
  });

  it("describes a new domain with the known addresses", () => {
    const out = jobChangeEvidence({
      signal: "domain",
      evidence: { email: "ada@newco.test", previousEmails: ["ada@old.test"] },
      proposal: { domain: "newco.test", organisationId: null },
    });
    expect(out.headline).toBe("Wrote from ada@newco.test, a new domain (newco.test)");
    expect(out.detail).toBe("Known addresses: ada@old.test");
  });
});
