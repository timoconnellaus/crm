// What the runtime's components share with the form that renders them: the "frame" of upstream.
import type { ConfiguratorUIOption } from "@crm/gatekeeper-configurator-ui";
import { createContext, useContext } from "react";

/** A CheckboxList's options for one `name`, kept for the life of the form. */
export type OptionsEntry =
  | { status: "loading"; promise: Promise<unknown> }
  | { status: "ready"; options: ConfiguratorUIOption[] }
  | { status: "failed"; message: string };

export type FrameContextValue = {
  /** Bumped by `clearFields(name)`, so the field's control starts afresh. */
  generation(name: string): number;
  /** CheckboxList options by name. */
  options: Map<string, OptionsEntry>;
};

const fallbackFrame: FrameContextValue = { generation: () => 0, options: new Map() };

export const FrameContext = createContext<FrameContextValue>(fallbackFrame);

export function useFrame(): FrameContextValue {
  return useContext(FrameContext);
}

/** What a Field tells the one control it labels. */
export type FieldContextValue = {
  controlId: string;
  labelId: string;
  descriptionId?: string;
  optional: boolean;
};

export const FieldContext = createContext<FieldContextValue | null>(null);

export function useField(): FieldContextValue | null {
  return useContext(FieldContext);
}
