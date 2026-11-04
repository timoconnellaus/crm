// App-wide commands any screen can trigger: the Cmd-K palette, the `?` shortcut sheet and the
// global create dialogs. The signed-in layout mounts the provider (and the dialogs it controls),
// so pages and the palette share one "New person" dialog.
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export type CreateKind = "person" | "organisation";

export interface AppCommands {
  openPalette: () => void;
  openShortcuts: () => void;
  /** Opens the create dialog for an object. */
  create: (kind: CreateKind) => void;
}

interface AppCommandsState extends AppCommands {
  palette: boolean;
  setPalette: (open: boolean) => void;
  shortcuts: boolean;
  setShortcuts: (open: boolean) => void;
  creating: CreateKind | null;
  setCreating: (kind: CreateKind | null) => void;
}

const AppCommandsContext = createContext<AppCommandsState | null>(null);

export function AppCommandsProvider({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  const value = useMemo<AppCommandsState>(
    () => ({
      palette,
      setPalette,
      shortcuts,
      setShortcuts,
      creating,
      setCreating,
      openPalette: () => setPalette(true),
      openShortcuts: () => setShortcuts(true),
      create: (kind) => {
        setPalette(false);
        setCreating(kind);
      },
    }),
    [palette, shortcuts, creating],
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
