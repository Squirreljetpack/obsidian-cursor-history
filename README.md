# Cursor History

An [Obsidian](https://obsidian.md) plugin that tracks cursor position history across files and lets you navigate back and forward. It can also remember your cursor positions and folded code blocks across files and restore them on reload.

## Features

- **Cursor Navigation**: Navigate back and forward through cursor history across files and notes (Edit & Reading views).
- **Position Heuristic**: Configurable line threshold (default 10 lines) creates history entries on larger jumps while updating in place for small movements.
- **Link Jump Tracking**: Intercepts internal link clicks (`[[note]]`) to capture your source position before navigation occurs.
- **History Navigator Modal**: Fuzzy search history modal (`Cursor History: Open history navigator`) to preview and jump to any recorded position for your active mode.
- **Recently Opened Files Modal**: Fuzzy search modal (`Cursor History: Open recently opened files`) to quickly switch to recently opened files with position restoration.
- **Current File History Modal**: Fuzzy search modal (`Cursor History: Open current file cursor history`) to view and jump between cursor positions within the active file (`line: line_initial_content`).
- **Scroll Position Restoration**: Restores exact scroll/line positions automatically when reopening files.
- **Folder-Local History**: Optional persistence to `.obsidian/cursor-history/cursor.json` inside your vault.
- **Code Block Folding (Reading Mode)**: Toggle fold code blocks in Reading mode with state persisted in `.obsidian/cursor-history/code-fold.json` and automatic pruning of missing block signatures.

## Installation

### Via BRAT (Recommended)

1. Install **BRAT** from Community Plugins.
2. Open BRAT settings -> **Add Beta plugin**.
3. Enter `Squirreljetpack/obsidian-cursor-history-fork`.

### Manual Installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/Squirreljetpack/obsidian-cursor-history-fork/releases/latest).
2. Create a folder `cursor-history` inside your vault's `.obsidian/plugins/` directory.
3. Place the downloaded files inside that folder.
4. Reload Obsidian and enable the plugin in **Settings > Community plugins**.

## Commands & Configuration

Default keybindings are set up automatically on first install:

| Command | Default Binding |
|---------|-----------------|
| Cursor History: Go back | Cmd+[ (`Mod+[`) |
| Cursor History: Go forward | Cmd+] (`Mod+]`) |
| Cursor History: Open history navigator | (Unbound) |
| Cursor History: Open recently opened files | (Unbound) |
| Cursor History: Open current file cursor history | (Unbound) |

To change them, open **Settings > Hotkeys** and search for "Cursor History".

## How It Works

The plugin uses VS Code's position-based heuristic:

- **Same line / Within threshold**: updates the current history entry
- **10+ lines apart / Different file**: creates a new history entry
- **Internal link click**: captures exact source position prior to page transition
- **Going back then navigating**: clears forward history (browser-style stack)

## License

[MIT](LICENSE)
