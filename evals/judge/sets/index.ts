// Every labelled set `pnpm eval:calibrate` runs (ADR 0231). A placement's questions get a set here,
// in a file of their own beside this one, before the placement ships.
import type { PlacementSet } from "../lib/calibrate.ts";
import { authoringIntentSet } from "./authoring-intent.ts";

// biome-ignore lint/suspicious/noExplicitAny: each set has its own state and answer types; the runner only passes them through.
export const SETS: PlacementSet<any, any>[] = [authoringIntentSet];
