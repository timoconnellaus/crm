#!/usr/bin/env node
// The changelog, generated from PR titles (ADR 0161). PRs land on main as squash merges whose
// subject is "<PR title> (#<number>)" (or as merge commits "Merge pull request #<n> …" with the
// title in the body); each release's notes list the PRs since the previous release tag on the same
// or a more stable channel. The notes are the GitHub Release body, which is what Settings →
// Updates and `crm status` show.
//
// Usage:
//   node scripts/release/changelog.ts --tag v1.2.0 [--repo owner/repo]   notes for one release
//   node scripts/release/changelog.ts --all > CHANGELOG.md               every release tag
import { execFileSync } from "node:child_process";
import { bareVersion, compareVersions, DEFAULT_REPOSITORY, isVersion } from "@crm/release";

export interface Commit {
  subject: string;
  body: string;
}

/** PR titles and numbers from first-parent commits. Commits that are not PRs are skipped. */
export function prTitles(commits: Commit[]): { number: number; title: string }[] {
  const out: { number: number; title: string }[] = [];
  for (const commit of commits) {
    const merge = /^Merge pull request #(\d+)\b/.exec(commit.subject);
    if (merge) {
      const title = commit.body
        .split("\n")
        .find((line) => line.trim())
        ?.trim();
      if (title) out.push({ number: Number(merge[1]), title });
      continue;
    }
    const squash = /^(.*\S)\s+\(#(\d+)\)$/.exec(commit.subject);
    if (squash) out.push({ number: Number(squash[2]), title: squash[1] as string });
  }
  return out;
}

export function releaseNotes(input: {
  tag: string;
  previous: string | null;
  prs: { number: number; title: string }[];
  repository: string;
}): string {
  const lines = ["## What's changed", ""];
  if (input.prs.length === 0) lines.push("- No pull requests since the previous release.");
  for (const pr of input.prs) {
    lines.push(`- ${pr.title} (https://github.com/${input.repository}/pull/${pr.number})`);
  }
  if (input.previous) {
    lines.push(
      "",
      `**Full changelog**: https://github.com/${input.repository}/compare/${input.previous}...${input.tag}`,
    );
  }
  lines.push(
    "",
    "Install with `npx create-crm --version " +
      bareVersion(input.tag) +
      "`, or update from Settings → Updates or with `npx create-crm upgrade`.",
  );
  return `${lines.join("\n")}\n`;
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" });
}

function releaseTags(): string[] {
  return git(["tag", "--list", "v*"])
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => isVersion(t))
    .sort((a, b) => compareVersions(a, b));
}

/** The release before `tag`: the newest older tag (a stable release skips betas). */
export function previousTag(tag: string, tags: string[]): string | null {
  const stable = !tag.includes("-");
  const older = tags.filter((t) => compareVersions(t, tag) < 0 && (!stable || !t.includes("-")));
  return older.at(-1) ?? null;
}

function commitsBetween(from: string | null, to: string): Commit[] {
  const range = from ? `${from}..${to}` : to;
  const raw = git(["log", "--first-parent", "--format=%s%x1f%b%x1e", range]);
  return raw
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject = "", body = ""] = entry.split("\x1f");
      return { subject: subject.trim(), body };
    });
}

function main() {
  const args = process.argv.slice(2);
  const repository = args.includes("--repo")
    ? (args[args.indexOf("--repo") + 1] as string)
    : (process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY);
  const tags = releaseTags();
  if (args.includes("--all")) {
    const sections = [
      "# Changelog",
      "",
      "Generated from PR titles by scripts/release/changelog.ts.",
      "",
    ];
    for (const tag of [...tags].reverse()) {
      const previous = previousTag(tag, tags);
      sections.push(
        `# ${tag}`,
        "",
        releaseNotes({ tag, previous, prs: prTitles(commitsBetween(previous, tag)), repository }),
      );
    }
    process.stdout.write(sections.join("\n"));
    return;
  }
  const tag = args.includes("--tag") ? (args[args.indexOf("--tag") + 1] as string) : undefined;
  if (!tag || !isVersion(tag)) throw new Error("--tag vX.Y.Z[-beta.N] is required");
  const previous = previousTag(tag, tags.includes(tag) ? tags : [...tags, tag]);
  const target = tags.includes(tag) ? tag : "HEAD";
  process.stdout.write(
    releaseNotes({ tag, previous, prs: prTitles(commitsBetween(previous, target)), repository }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
