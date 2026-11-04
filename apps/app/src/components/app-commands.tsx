// App-wide commands any screen can trigger: the Cmd-K palette, the `?` shortcut sheet and the
// global create dialogs. The signed-in layout mounts the provider (and the dialogs it controls),
// so pages and the palette share one "New person" and one "New task" dialog.
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export type CreateKind = "person" | "task";

/** A record a new item is about (a task's link). */
export interface CreateLink {
  object: "person" | "organisation";
  id: string;
  /** Display name, shown in the dialog. */
  title?: string;
}

export interface CreateOptions {
  /** Link the new item to this record (tasks). */
  link?: CreateLink;
}

export interface AppCommands {
  openPalette: () => void;
  openShortcuts: () => void;
  /** Opens the create dialog for an object. */
  create: (kind: CreateKind, options?: CreateOptions) => void;
}

interface AppCommandsState extends AppCommands {
  palette: boolean;
  setPalette: (open: boolean) => void;
  shortcuts: boolean;
  setShortcuts: (open: boolean) => void;
  creating: CreateKind | null;
  createOptions: CreateOptions;
  setCreating: (kind: CreateKind | null) => void;
}

const AppCommandsContext = createContext<AppCommandsState | null>(null);

export function AppCommandsProvider({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  const [createOptions, setCreateOptions] = useState<CreateOptions>({});
  const value = useMemo<AppCommandsState>(
    () => ({
      palette,
      setPalette,
      shortcuts,
      setShortcuts,
      creating,
      createOptions,
      setCreating,
      openPalette: () => setPalette(true),
      openShortcuts: () => setShortcuts(true),
      create: (kind, options = {}) => {
        setPalette(false);
        setCreateOptions(options);
        setCreating(kind);
      },
    }),
    [palette, shortcuts, creating, createOptions],
  );
  return <AppCommandsContext.Provider value={value}>{children}</AppCommandsContext.Provider>;
}

/** Internal: the provider's state, for the dialogs it controls. */
export function useAppCommandsState(): AppCommandsState {
  const value = useContext(AppCommandsContext);
  if (!value) throw new Error("useAppCommands needs AppCommandsProvider");
  return value;
}

export function useAppCommands(): AppCommands {
  return useAppCommandsState();
}
