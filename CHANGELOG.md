# Changelog

All notable changes to this project will be documented in this file.

## [1.5.0] - 2026-07-26

### Changed

- **In-Memory Date Toggle in Modals**: Removed `showDateInModal` from global plugin settings and `saveSettings()`. Date visibility is now an in-memory modal property (default off; `Cmd+S` / `Ctrl+S` toggles it per modal session).
- **Native Hotkey Handling**: Removed `hotkeyDefaultsApplied` setting and direct `hotkeys.json` file manipulation in favor of Obsidian's native `addCommand` default hotkey handling.

## [1.4.0] - 2026-07-25

### Added

- **Startup Missing Files Cleanup**: Automatically kick off a non-blocking background job on startup to remove cursor histories for files that no longer exist in the vault.
- **Truncate History Command**: New command `Truncate cursor history` to prompt user for $N$ (default 0) and truncate in-memory navigation stack and per-file position histories to the $N$ most recent entries.
- **Toggle Access Time Shortcut in Recent Files Modal**: Added `Meta+S` (`Mod+S`) shortcut inside the `Open recently opened files` modal to toggle displaying formatted access timestamps in gray on the right side.

## [1.3.1] - 2026-07-24

### Changed

- **Subfolder History Location**: Moved vault-level history files into `.obsidian/cursor-history/` subfolder (`code-fold.json` and `cursor.json`) with automatic directory creation.
- **Active File Stack History**: Record active file to history stack on file activation.

## [1.3.0] - 2026-07-22

### Changed

- **Improved Preview Click Tracking**: Replaced scroll-position-based detection with direct DOM line-element detection for more accurate cursor history entries in Reading mode. Interactive elements (links, buttons, inputs) are now excluded from click tracking.
- **Max Line Length Setting**: New `Max line length in current file history` setting to truncate long line content displayed in the current file cursor history modal (default: 120).
- **Scroll Debounce Setting**: New `Reading mode scroll debounce (ms)` setting to configure how long to wait after the last scroll event before recording position in Reading mode (default: 100).
- **Recent Files Modal Display**: Strip `.md` extension from file paths displayed in the recently opened files modal.

## [1.2.0] - 2026-07-22

### Added

- **Recently Opened Files Modal**: Command `Open recently opened files` to fuzzy search recently opened notes ordered by recency (excluding the active file) and jump directly to them.
- **Current File Navigation History Modal**: Command `Open current file cursor history` to fuzzy search in-memory cursor navigation history for the active file, displayed as `line: line_initial_content`.
- **Show Date in Modals Setting**: Added an option in settings to display formatted timestamps in gray next to items in history modals.

### Changed

- **Per-File Cursor Histories**: Replaced single persistent stack history with per-file cursor history storage (`fileLastPositions`) without redundant basename storage.

## [1.1.0] - 2026-07-21

### Added

- **Separate Mode Stacks & Command Hotkeys**:
  - Maintained distinct, isolated navigation stacks for Edit Mode and Reading Mode.
  - Set default hotkeys for `Go back` and `Go forward` to `Cmd + [` (`Mod+[`) and `Cmd + ]` (`Mod+]`).
  - History Navigator Modal automatically detects the current view mode (defaulting to Read mode if no mode is active) and displays only the entries for that mode.
- **Code Block Folding (Reading Mode)**:
  - Toggle fold buttons next to Obsidian's copy button on rendered code blocks.
  - Persistent fold state saved in `.obsidian/code-fold-history.json` with `fold_all` state and missing block auto-pruning.
  - Command `Toggle fold all code blocks` in command palette.
- **Folder-Local History**:
  - Optional vault-level history storage (`.obsidian/cursor-history.json`).
- **Scroll & Position Restoration**:
  - Auto-restoration of exact selection and scroll line/offset on file open and Reading View navigation.
- **Link Jump Tracking & History Modal**:
  - Click tracking on internal links (`a.internal-link`) before page navigation.
  - Fuzzy-search history navigator modal command.
- **Sanitization & Settings**:
  - Auto-cleanup of embed references (`![[...`), deleted notes, or invalid paths.
  - Configurable max history entries and line jump thresholds.
