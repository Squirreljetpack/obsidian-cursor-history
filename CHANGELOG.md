# Changelog

All notable changes to this project will be documented in this file.

## [1.3.1] - 2026-07-24

### Changed

- **Subfolder History Location**: Moved vault-level history files into `.obsidian/cursor-history/` subfolder (`code-fold.json` and `cursor.json`) with automatic directory creation.
- **Active File Stack History**: Record active file to history stack without saving to disk on file activation, chained directly after scroll restoration finishes.

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
