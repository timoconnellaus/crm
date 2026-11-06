import { describe, expect, it } from "vitest";
import { heardText, PlayoutClock, playoutFor, type SpokenSegment } from "../src/index.ts";

const one: SpokenSegment[] = [
  { text: "On the call Lena said the budget is approved.", audioMs: 3000 },
  { text: "She also asked for SSO.", audioMs: 1500 },
];

describe("playoutFor", () => {
  it("is spoken when everything played", () => {
    expect(playoutFor(one, 4500)).toEqual({ state: "spoken" });
    expect(playoutFor(one, 4400)).toEqual({ state: "spoken" });
  });

  it("is unspoken when nothing was heard", () => {
    expect(playoutFor(one, 0)).toEqual({ state: "unspoken" });
    expect(playoutFor(one, 100)).toEqual({ state: "unspoken" });
    expect(playoutFor([], 2000, "Never got as far as speech.")).toEqual({ state: "unspoken" });
  });

  it("keeps the words not heard, by share of audio without timings", () => {
    const playout = playoutFor(one, 3000);
    expect(playout).toEqual({ state: "partly_spoken", unsaid: "She also asked for SSO." });
  });

  it("uses word timings when the provider sent them", () => {
    const timed: SpokenSegment[] = [
      {
        text: "Call Lena back today.",
        audioMs: 2000,
        words: [
          { word: "Call", start: 0, end: 400 },
          { word: "Lena", start: 400, end: 900 },
          { word: "back", start: 900, end: 1400 },
          { word: "today.", start: 1400, end: 2000 },
        ],
      },
    ];
    expect(playoutFor(timed, 1000)).toEqual({ state: "partly_spoken", unsaid: "back today." });
  });

  it("counts sentences that never reached speech as unsaid", () => {
    const playout = playoutFor(one.slice(0, 1), 3000, `${one[0]?.text} ${one[1]?.text}`);
    expect(playout).toEqual({ state: "partly_spoken", unsaid: "She also asked for SSO." });
  });

  it("does not count a sentence with no audio as heard", () => {
    const segments = [one[0] as SpokenSegment, { text: "Queued.", audioMs: 0 }];
    expect(heardText(segments, 3000)).toBe(one[0]?.text);
  });
});

describe("PlayoutClock", () => {
  it("plays chunks back to back, and waits when playback ran dry", () => {
    const clock = new PlayoutClock();
    clock.add(0, 100);
    clock.add(10, 100);
    expect(clock.endsAt).toBe(200);
    expect(clock.played(150)).toBe(150);
    clock.add(500, 100);
    expect(clock.played(450)).toBe(200);
    expect(clock.played(550)).toBe(250);
    expect(clock.isPlaying(650)).toBe(false);
  });
});
