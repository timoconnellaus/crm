// Minimal entry for the Workers test pool. The real entry is TanStack Start's server entry.
// Durable Object classes bound in wrangler.jsonc must be exported here too.
export { AssistantConversation } from "../src/server/assistant/conversation.ts";
export default {
  fetch: () => new Response("test worker"),
} satisfies ExportedHandler<Env>;
