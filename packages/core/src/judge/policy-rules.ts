// The written policy as numbered rules (ADR 0230, for the adjudicator's Jev reviewer in build
// step 5): each non-empty line or bullet of the policy text is one rule, split by code, never by a
// model, and shown numbered on the settings page so the admin sees what the reviewer sees.

/** The most rules the Jev reviewer takes: Choice allows 255 options, accuracy falls long before. */
export const MAX_POLICY_RULES = 60;

export interface PolicyRule {
  /** 1-based, as the settings page and the approver's reason show it. */
  number: number;
  text: string;
}

const BULLET = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/;

/**
 * One rule per non-empty line. Bullets and list numbers are dropped; Markdown headings and
 * horizontal rules are not rules. An indented line that is not itself a bullet continues the rule
 * before it.
 */
export function policyRules(text: string): PolicyRule[] {
  const rules: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const line = raw.trimEnd();
    if (/^\s*#{1,6}\s/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    if (/^\s{2,}\S/.test(line) && !BULLET.test(line) && rules.length > 0) {
      rules[rules.length - 1] = `${rules[rules.length - 1]} ${line.trim()}`;
      continue;
    }
    const rule = line.replace(BULLET, "").trim();
    if (rule) rules.push(rule);
  }
  return rules.map((text, i) => ({ number: i + 1, text }));
}
