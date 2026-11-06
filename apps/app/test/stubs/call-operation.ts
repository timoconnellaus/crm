// A stand-in for the UI's one server function, which needs TanStack Start's build. Tests that render
// components (a2ui-cards.test.tsx) never call it: there is no browser to call it from.
export async function callOperation(): Promise<never> {
  throw new Error("No operations in a render test");
}
