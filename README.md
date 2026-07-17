# Local History

based on https://github.com/zabel-xyz/local-history which seems abandoned

- check [CHANGELOG](CHANGELOG.md)

> ## Visual Timeline

![demo](https://github.com/ctf0/local-history/releases/download/010/demo.png)

A full-featured diff viewer for navigating file history with snapshot-to-current diffing.

### Interactive Diff & Hunk Management

- **Hunk-level apply/reject** — click any changed line block to apply snapshot changes to the current file, or reject current changes (restoring snapshot content).
- **Partial (single-line) hunk actions** — `Cmd/Ctrl + Click` a single line within a hunk to apply or reject just that line, leaving the rest of the hunk unchanged.
- **Undo stack** — every hunk/line action is backed by a file-based undo copy, so you can undo with `Cmd/Ctrl + Z`. Undo survives timeline navigation and panel close/reopen within the same session. Configurable with `localHistory.fileBackedUndo`.
- **Context menu** — right-click any line/hunk to copy its content.

### Visuals

- **Side-by-side & Unified views** — toggle between side-by-side (default) and unified diff layout. The view automatically switches to unified when the editor is narrow, controlled by `diffEditor.renderSideBySideInlineBreakpoint`.
- **Inline word-level diff** — changed lines show inline word highlighting (red/green spans within the line) for precise change visibility.
- **Syntax highlighting** — full syntax highlighting on both the snapshot and current file sides via TextMate grammars.
- **Themed** — uses active VS Code theme colors (editor, diff editor, title bar, button, scrollbar, etc.) and respects `editor.lineHeight`, `editor.fontFamily`, `editor.fontSize` settings.
- **Collapsible unchanged regions** — respects `diffEditor.hideUnchangedRegions` settings; unchanged blocks can be collapsed/expanded with a click.

### Snapshot Navigation

- **Timeline strip** — a horizontal timeline bar at the top shows all snapshots as dots with dates. Click any dot to jump directly to that snapshot. Scroll horizontally with the mouse wheel.
- **Arrow keys `←` / `→`** to step between snapshots (older/newer). Fast repeated presses are debounced for smooth rendering.
- **Counter display** — shows current position (e.g. `3 / 15`) between the prev/next buttons.
- **Direct snapshot actions** — open any snapshot in an editor ("Open in Editor" button) or restore it to the current file with a confirmation dialog (`Restore This Version` button).
- **Cursor tracking** — when the timeline opens, the view scrolls to the current line under cursor in the editor (for quick view of the line history).
- **Scroll Sync** between right/left views.

### Default View

- Configurable via `localHistory.defaultView` (`side-by-side` or `unified`).

### Keyboard Shortcuts

| Command                     | Windows            | macOS             |
| --------------------------- | ------------------ | ----------------- |
| Switch mode                 | `Tab`              | `Tab`             |
| Previous checkpoint         | `←`                | `←`               |
| Next checkpoint             | `→`                | `→`               |
| Scroll up/down              | `↑` / `↓`          | `↑` / `↓`         |
| Scroll to top/bottom        | `Ctrl` + `↑` / `↓` | `Cmd` + `↑` / `↓` |
| Close timeline/context menu | `Esc`              | `Esc`             |
| Zoom in                     | `Ctrl` + `+`       | `Cmd` + `+`       |
| Zoom out                    | `Ctrl` + `-`       | `Cmd` + `-`       |
| Reset zoom                  | `Ctrl` + `0`       | `Cmd` + `0`       |
| Undo hunk action            | `Ctrl` + `Z`       | `Cmd` + `Z`       |

<br>

># Local History
>
>A visual source code plugin for maintaining local history of files.
>
>Every time you modify a file, a copy of the old contents is kept in the local history.
>At any time, you can compare a file with any older version from the history.
>It can help you out when you change or delete a file by accident.
>The history can also help you out when your workspace has a catastrophic problem.
>Each file revision is stored in a separate file inside the .history folder of your workspace directory
>(you can also configure another location, see local-history.path).
>e.g., `.history/foo/bar/myFile_20151212205930.ts`
>
>You can easily navigate between history files with the `local-history tree` in the explorer pane.<BR>
>
>When you click on a file, a comparaison with the current version is displayed.<BR>
>You can also access other commands via a context menu.<BR>
>
>![Image of tree](https://github.com/zabel-xyz/local-history/blob/master/images/Tree.png)
>
>You have different views to filter:
>
>- all
>- current file (default)
>- specific file (you can enter a search pattern)
>
>![Image of tree](https://github.com/zabel-xyz/local-history/blob/master/images/Tree2.png)
>
>The files displayed depend on setting `localHistory.maxDisplay` to see more, use search-plus icon.
>
>## Settings
>
>```jsonc
> "localHistory.daysLimit":  30  // A day number to purge local history. (0: no purge)
> "localHistory.maxDisplay": 10  // A max files to display with local history commands
> "localHistory.saveDelay":   0  // A delay in seconds to save file in local history. {0: no delay}
> "localHistory.dateLocale":     // The locale to use when displaying date (e.g.: "fr-CH" or "en-GB" or ...)
> "localHistory.dateFormat":     // Date format: "timestamp" (28/05/2026, 20:07:00) or "human" (Thu, May 28, 2026, 08:07 PM)
>
> "localHistory.path":     // Specify another location for .history folder (null: use workspaceFolder)
> This settings must be an absolute path.
>
>   You can start your path with:
>       - ${workspaceFolder}: current workspace folder
>           e.g. ${workspaceFolder}/.vscode to save in each workspace folder .vscode/.history
>       - ${workspaceFolder: index}: specific workspace index
>           e.g. workspace folders A, B, C. But save always in A/.history => ${workspaceFolder: 0}
>
>   Your can also use specific variable in path:
>       - %variable%: an environnement variable (e.g. %AppData%)
>       - ~: the home directory (linux)
>
> "localHistory.absolute": // Save absolute or relative path in localHistory.path
>    true:  (absolute) // <localHistory.path>/.history/<absolutePath>
>    false: (relative) // (default) <localHistory.path>/.history/<workspaceFolder.basename>/<relativePath>
>
> "localHistory.enabled":
>    0: Never     // Possibility to disabled the extension for some project
>    1: Always    // (default) Save also single file with no workspaceFolder ("localHistory.path" must be defined)
>    2: Workspace // Save only files within workspaceFolder
>
> "localHistory.exclude": // Files or folders to not save
> // (default) ['**/.history/**', '**/.vscode**', '**/node_modules/**', '**/typings/**', '**/out/**']
>
> "localHistory.treeLocation": // Specify a location for tree view
>    explorer (default): // Show tree in Explorer item
>    localHistory:       // Show tree in a special active bar item
>```
>
>## Commands
>
>```jsonc
> local-history.showAll // Show all history available to select (limited with maxDisplay settings)
> local-history.showCurrent // Show current version (if history version is active)
> local-history.compareToCurrent // compare current version with another version in history
> local-history.compareToActive // compare active file with another version in history
> local-history.compareToPrevious // compare a version in history with its previous version
>```
>
>## Note
>
>When .history folder is stored in workspace, you can add a "files.exclude".
>This hides .history folder and avoids some issues. (e.g. csproj extension)<BR>
>Thanks to @pabloarista (issue [#13](https://github.com/zabel-xyz/local-history/issues/13))
