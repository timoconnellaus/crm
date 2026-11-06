// Minimal entry for the Workers test pool. The real entry is TanStack Start's server entry.
// Durable Object classes bound in wrangler.jsonc must be exported here too.
export { AssistantAgent } from "../src/server/assistant/agent.ts";
export { AgentJob } from "../src/server/assistant/job.ts";
export default {
  fetch: () => new Response("test worker"),
} satisfies ExportedHandler<Env>;
