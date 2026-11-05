// The written policy as numbered rules (ADR 0232 decision 5, ADR 0233), for the adjudicator's Jev
// reviewer: each non-empty line or bullet of the policy text is one rule, split by code, never by
// a model, and shown numbered on the settings page so the admin sees what the reviewer sees.

/** The most rules the Jev reviewer takes: Choice allows 255 options, accuracy falls long before. */
export const MAX_POLICY_RULES = 60;

export interface PolicyRule {
  /** 1-based, as the settings page and the approver's reason show it. */
  number: number;
  text: string;
}

const BULLET = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;
const HEADING = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * One rule per non-empty line. Bullets and list numbers are dropped; Markdown headings and
 * horizontal rules are not rules. An indented line that is not itself a bullet continues the rule
 * before it.
 *
 * A section heading qualifies the rules beneath it (ADR 0233): under "## Deny", the line "Deleting
 * more than 5 records" is the rule "Deny: Deleting more than 5 records", because a rule read on
 * its own must keep the meaning its section gave it. A level-1 heading is the policy's title and
 * qualifies nothing, unless the policy uses level-1 headings as its sections (more than one).
 */
export function policyRules(text: string): PolicyRule[] {
  const lines = text.split(/\r?\n/);
  const titles = lines.filter((l) => HEADING.exec(l)?.[1]?.length === 1).length;
  const rules: string[] = [];
  let section: string | null = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = raw.trimEnd();
    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const words = (heading[2] as string).replace(/:$/, "").trim();
      if (level > 1 || titles > 1) section = words || null;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    if (/^\s{2,}\S/.test(line) && !BULLET.test(line) && rules.length > 0) {
      rules[rules.length - 1] = `${rules[rules.length - 1]} ${line.trim()}`;
      continue;
    }
    const rule = line.replace(BULLET, "").trim();
    if (rule) rules.push(section ? `${section}: ${rule}` : rule);
  }
  return rules.map((text, i) => ({ number: i + 1, text }));
}
