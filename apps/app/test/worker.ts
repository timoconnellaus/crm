// Minimal entry for the Workers test pool. The real entry is TanStack Start's server entry.
export default {
  fetch: () => new Response("test worker"),
} satisfies ExportedHandler<Env>;
