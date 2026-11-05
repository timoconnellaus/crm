// Terminal I/O for the CLI: output, prompts (readline, no dependencies) and a redactor that keeps
// secret values out of everything the CLI prints.
import { createInterface } from "node:readline/promises";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Free-text answer; `secret` hides it from the terminal echo where possible. */
  ask(question: string, options?: { default?: string; secret?: boolean }): Promise<string>;
  interactive: boolean;
}

/** Replaces any registered secret value with `***` in output. */
export class Redactor {
  private readonly values = new Set<string>();
  add(value: string | undefined) {
    if (value && value.length >= 6) this.values.add(value);
  }
  clean(text: string): string {
    let out = text;
    for (const value of this.values) out = out.split(value).join("***");
    return out;
  }
}

export function terminalIo(redactor: Redactor): Io {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    interactive,
    out: (line) => process.stdout.write(`${redactor.clean(line)}\n`),
    err: (line) => process.stderr.write(`${redactor.clean(line)}\n`),
    async ask(question, options = {}) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      const suffix = options.default ? ` [${options.default}]` : "";
      if (options.secret) {
        // Mute echo while the secret is typed.
        const output = rl as unknown as { _writeToOutput?: (s: string) => void };
        const prompt = `${question}${suffix}: `;
        process.stdout.write(prompt);
        output._writeToOutput = () => {};
        const answer = await rl.question("");
        process.stdout.write("\n");
        rl.close();
        return answer.trim() || options.default || "";
      }
      const answer = await rl.question(`${question}${suffix}: `);
      rl.close();
      return answer.trim() || options.default || "";
    },
  };
}

/** Asks for one of `choices` (by number or value). */
export async function choose(io: Io, question: string, choices: string[], fallback?: string) {
  if (choices.length === 1) return choices[0] as string;
  io.out(question);
  for (const [i, c] of choices.entries()) io.out(`  ${i + 1}) ${c}`);
  for (;;) {
    const answer = await io.ask("Choose", fallback ? { default: fallback } : {});
    const index = Number(answer) - 1;
    if (choices[index]) return choices[index] as string;
    if (choices.includes(answer)) return answer;
    io.err(`Pick 1-${choices.length}.`);
  }
}
