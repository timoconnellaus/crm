import { describe, expect, it } from "vitest";
import { firstSentences, SpeechPicker, splitSpoken, toSpeech } from "../src/index.ts";

function pick(mode: "short" | "full", deltas: string[]) {
  const picker = new SpeechPicker(mode);
  const said = deltas.map((d) => picker.push(d)).join("");
  return { said: said + picker.end(), picked: picker.picked };
}

describe("splitSpoken", () => {
  it("separates the spoken version from what the chat shows", () => {
    expect(splitSpoken("<say>Six overdue.</say>\nHere they are:")).toEqual({
      say: "Six overdue.",
      shown: "Here they are:",
    });
  });

  it("copes with a reply still streaming", () => {
    expect(splitSpoken("<say>Six ov")).toEqual({ say: "Six ov", shown: "" });
    expect(splitSpoken("Hello <sa").shown).toBe("Hello ");
    expect(splitSpoken("Plain text").say).toBeNull();
  });
});

describe("SpeechPicker", () => {
  it("says only the block in short mode, across split tags", () => {
    expect(pick("short", ["<sa", "y>Six ", "overdue.</s", "ay> The full list."]).said).toBe(
      "Six overdue.",
    );
  });

  it("falls back to the first sentences when a short reply has no block", () => {
    const { said } = pick("short", ["One. Two. ", "x".repeat(300), "."]);
    expect(said).toBe("One. Two.");
  });

  it("reads everything in full mode, without a block", () => {
    expect(pick("full", ["Hello ", "there.", " <say>x</say>Bye."]).said).toBe("Hello there. Bye.");
  });
});

describe("toSpeech", () => {
  it("turns Markdown into words", () => {
    expect(toSpeech("**Acme** [site](https://a.b) → `done`\n- one\n- two")).toBe(
      "Acme site to done\none\ntwo",
    );
  });
});

describe("firstSentences", () => {
  it("keeps at least one sentence", () => {
    expect(firstSentences("A long sentence here. Another.", 5)).toBe("A long sentence here.");
  });
});
