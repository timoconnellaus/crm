// Entry point for `npx create-relationship-os` and `ros`.
import { ghAvailable, ghVerifier } from "./gh.ts";
import { Redactor, terminalIo } from "./io.ts";
import { runCli } from "./main.ts";

const redactor = new Redactor();
const code = await runCli(process.argv.slice(2), {
  io: terminalIo(redactor),
  redactor,
  env: process.env,
  ghVerifier: (await ghAvailable()) ? ghVerifier : null,
});
process.exitCode = code;
