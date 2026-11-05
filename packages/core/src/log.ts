// What may go to Workers Logs (ADR 0320): errors are logged by kind, code and where they were
// thrown, never with record content. An error's message can quote what it was about (a taken
// email address, a phone number, a value from a provider), and Workers Logs is outside an erase's
// reach, so addresses and long digit runs are masked before anything is logged.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** Seven or more digits, with the separators phone numbers use. */
const NUMBER = /\+?\d[\d\s().-]{5,}\d/g;

/** `text` with email addresses and phone-like numbers masked. */
export function maskForLog(text: string): string {
  return text.replace(EMAIL, "[address]").replace(NUMBER, "[number]");
}

/**
 * An error as one log-safe line: its name, code (for operation errors), masked message and the
 * first frames of its stack. Pass this to `console.error` instead of the error itself.
 */
export function errorForLog(error: unknown): string {
  if (!(error instanceof Error)) return maskForLog(String(error)).slice(0, 500);
  const code = (error as { code?: unknown }).code;
  const head = `${error.name}${typeof code === "string" ? ` [${code}]` : ""}: ${error.message}`;
  const frames = (error.stack ?? "")
    .split("\n")
    .slice(1, 6)
    .map((line) => line.trim())
    .join(" | ");
  return maskForLog(`${head}${frames ? ` @ ${frames}` : ""}`).slice(0, 2000);
}
