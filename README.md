# Cursor History

An [Obsidian](https://obsidian.md) plugin that tracks cursor position history across files and lets you navigate back and forward. It can also remember your cursor positions and folded code blocks across files and restore them on reload.

## Features

- **Cursor Navigation**: Navigate back and forward through cursor history across files and notes (Edit & Reading views).
- **Position Heuristic**: Configurable line threshold creates history entries on larger jumps while updating in place for small movements.
- **Link Jump Tracking**: Intercepts internal link clicks (`[[note]]`) to capture your source position before navigation occurs.
- **History Modal**: Fuzzy search history modal (`Cursor History: Open cursor history`) to preview and jump to recorded positions. Toggle between Current File History and Global History with `Tab`. Open in new tab with `Cmd+Enter`, horizontal split with `Cmd+-`, or vertical split with `Cmd+I`. Clear history with `Cmd+L` / `Ctrl+L` (`Meta+L`).
- **Recently Opened Files Modal**: Fuzzy search modal (`Cursor History: Open recently opened files`) to quickly switch to recently opened files with position restoration.
- **Scroll Position Restoration**: Restores exact scroll/line positions automatically when reopening files.
- **Folder-Local History**: Optional persistence to `.obsidian/cursor-history/cursor.json` inside your vault.
- **Code Block Folding (Reading Mode)**: Toggle fold code blocks in Reading mode with state persisted in `.obsidian/cursor-history/code-fold.json` and automatic pruning of missing block signatures.

## Installation

### Via BRAT (Recommended)

1. Install **BRAT** from Community Plugins.
2. Open BRAT settings -> **Add Beta plugin**.
3. Enter `Squirreljetpack/obsidian-cursor-history`.

### Manual Installation

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/Squirreljetpack/obsidian-cursor-history/releases/latest).
2. Create a folder `cursor-history` inside your vault's `.obsidian/plugins/` directory.
3. Place the downloaded files inside that folder.
4. Reload Obsidian and enable the plugin in **Settings > Community plugins**.

## Commands & Configuration

| Command | Default Binding |
|---------|-----------------|
| Cursor History: Go back | `Cmd+[` |
| Cursor History: Go forward | `Cmd+]` |
| Cursor History: Open cursor history | (Unbound) |
| Cursor History: Open recently opened files | (Unbound) |
| Cursor History: Truncate cursor history | (Unbound) |
| Cursor History: Toggle fold all code blocks | (Unbound) |

To change them, open **Settings > Hotkeys** and search for "Cursor History".

## How It Works

The plugin uses VS Code's position-based heuristic:

- **Same line / Within threshold**: updates the current history entry
- **10+ lines apart / Different file**: creates a new history entry
- **Internal link click**: captures exact source position prior to page transition
- **Going back then navigating**: clears forward history (browser-style stack)

## License

[MIT](LICENSE)
