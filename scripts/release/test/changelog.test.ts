import { describe, expect, it } from "vitest";
import { previousTag, prTitles, releaseNotes } from "../changelog.ts";

describe("changelog from PR titles", () => {
  it("reads squash and merge commits, and skips the rest", () => {
    expect(
      prTitles([
        { subject: "Stage 6a: integrations (#29)", body: "" },
        { subject: "Merge pull request #31 from someone/branch", body: "\nFix the thing\n" },
        { subject: "chore: local commit", body: "" },
      ]),
    ).toEqual([
      { number: 29, title: "Stage 6a: integrations" },
      { number: 31, title: "Fix the thing" },
    ]);
  });

  it("a stable release compares with the previous stable one; a beta with anything older", () => {
    const tags = ["v1.0.0", "v1.1.0-beta.1", "v1.1.0-beta.2", "v1.1.0"];
    expect(previousTag("v1.1.0", tags)).toBe("v1.0.0");
    expect(previousTag("v1.1.0-beta.2", tags)).toBe("v1.1.0-beta.1");
    expect(previousTag("v1.0.0", tags)).toBeNull();
  });

  it("writes notes with links", () => {
    const notes = releaseNotes({
      tag: "v1.1.0",
      previous: "v1.0.0",
      prs: [{ number: 29, title: "Stage 6a" }],
      repository: "o/r",
    });
    expect(notes).toContain("- Stage 6a (https://github.com/o/r/pull/29)");
    expect(notes).toContain("compare/v1.0.0...v1.1.0");
  });
});
