import { describe, expect, it } from "vitest";
import { heardReply, toModelMessage } from "../src/thread.ts";

describe("heardReply", () => {
  it("leaves a reply that was heard alone", () => {
    expect(heardReply("All of it.", { state: "spoken" })).toBe("All of it.");
    expect(heardReply("Not spoken at all.", undefined)).toBe("Not spoken at all.");
  });

  it("cuts a read-out reply where it stopped", () => {
    const text = "Lena said the budget is approved. She also asked for SSO.";
    expect(
      heardReply(text, { state: "partly_spoken", unsaid: "She also asked for SSO." }),
    ).toBe("Lena said the budget is approved. [The person spoke over the rest and did not hear it.]");
  });

  it("cuts only the spoken block when the answer was on screen", () => {
    const text = "<say>Six overdue. The top one is Acme.</say>\nHere they are: one, two.";
    expect(
      heardReply(text, { state: "partly_spoken", unsaid: "The top one is Acme." }),
    ).toBe(
      "<say>Six overdue. [The person spoke over the rest and did not hear it.]</say>\nHere they are: one, two.",
    );
  });

  it("says which words were missed when Markdown keeps them from matching", () => {
    const out = heardReply("**Call** Lena.", { state: "partly_spoken", unsaid: "Call Lena." });
    expect(out).toContain('did not hear: "Call Lena."');
  });

  it("shows nothing of a reply that was not heard, except what was on screen", () => {
    expect(heardReply("Never heard.", { state: "unspoken" })).not.toContain("Never heard");
    const shown = heardReply("<say>Short.</say> The full answer.", { state: "unspoken" });
    expect(shown).not.toContain("Short.");
    expect(shown).toContain("The full answer.");
  });

  it("is what the model is sent", () => {
    const message = toModelMessage({
      seq: 2,
      turn: 1,
      role: "assistant",
      via: "voice",
      parts: [{ type: "text", text: "First part. Second part here now." }],
      playout: { state: "partly_spoken", unsaid: "Second part here now." },
      createdAt: "",
    });
    expect(JSON.stringify(message)).not.toContain("Second part");
  });
});
