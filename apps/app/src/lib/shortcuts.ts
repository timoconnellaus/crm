// The keyboard shortcuts the app registers, listed once for the `?` sheet. Keep this in step with
// the useHotkey calls (shell, DataTable, FilterBuilder, record pages).

export interface ShortcutDescription {
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutDescription[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    shortcuts: [
      { keys: ["⌘", "K"], label: "Open the command palette (Ctrl K on Windows and Linux)" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      {
        keys: ["c"],
        label: "Create in context (a person on People, a task on Tasks or a record page)",
      },
    ],
  },
  {
    title: "Lists",
    shortcuts: [
      { keys: ["/"], label: "Open the filter builder" },
      { keys: ["j"], label: "Next row" },
      { keys: ["k"], label: "Previous row" },
      { keys: ["x"], label: "Select or deselect the row" },
      { keys: ["Enter"], label: "Open the row" },
    ],
  },
  {
    title: "Records",
    shortcuts: [
      { keys: ["e"], label: "Edit details" },
      { keys: ["Esc"], label: "Cancel editing" },
      { keys: ["⌘", "Enter"], label: "Save details" },
    ],
  },
];
