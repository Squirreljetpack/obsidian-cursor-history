import { App, PluginSettingTab, Setting } from "obsidian";
import type CursorHistoryPlugin from "./main.js";

export interface CursorHistorySettings {
  useFolderLocalHistory: boolean;
  restoreScrollPosition: boolean;
  rememberModeOnFileOpen: boolean;
  initialModal: "current" | "global";
  maxEntries: number;
  maxLineLength: number;
  editColOffset: number;
  currentFilePreviewFuzzLines: number;
  openRecordDelayMs: number;
  editJumpThreshold: number;
  previewJumpThreshold: number;
  scrollDebounceMs: number;
  historySaveDelaySec: number;
}

export const DEFAULT_SETTINGS: CursorHistorySettings = {
  useFolderLocalHistory: false,
  restoreScrollPosition: true,
  rememberModeOnFileOpen: false,
  initialModal: "current",
  maxEntries: 50,
  maxLineLength: 120,
  editColOffset: 10,
  currentFilePreviewFuzzLines: 0,
  openRecordDelayMs: 1000,
  editJumpThreshold: 1,
  previewJumpThreshold: 10,
  scrollDebounceMs: 100,
  historySaveDelaySec: 10,
};

export class CursorHistorySettingTab extends PluginSettingTab {
  plugin: CursorHistoryPlugin;

  constructor(app: App, plugin: CursorHistoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Cursor History Settings" });

    // Section 1: Navigation & File Behavior
    containerEl.createEl("h3", { text: "Navigation & File Behavior" });

    new Setting(containerEl)
      .setName("Restore scroll position on file open")
      .setDesc("Automatically restore the last known cursor or scroll position when opening a file in the normal way")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.restoreScrollPosition)
          .onChange(async value => {
            this.plugin.settings.restoreScrollPosition = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remember mode on file open")
      .setDesc("Automatically switch file mode (edit/reading mode) to the most recently used mode when opening a file")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.rememberModeOnFileOpen)
          .onChange(async value => {
            this.plugin.settings.rememberModeOnFileOpen = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("File open record delay (ms)")
      .setDesc(
        "Delay in milliseconds after opening a file before recording the settled position in navigation stack",
      )
      .addText(text =>
        text
          .setPlaceholder("1000")
          .setValue(String(this.plugin.settings.openRecordDelayMs ?? 1000))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.openRecordDelayMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // Section 2: History Storage & Capacity
    containerEl.createEl("h3", { text: "History Storage & Capacity" });

    new Setting(containerEl)
      .setName("Use folder local history")
      .setDesc("Save history to .obsidian/cursor-history/cursor.json instead of plugin data.json")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.useFolderLocalHistory)
          .onChange(async value => {
            this.plugin.settings.useFolderLocalHistory = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("History save delay (seconds)")
      .setDesc("Delay in seconds before auto-saving history changes to disk")
      .addText(text =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.historySaveDelaySec ?? 10))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.historySaveDelaySec = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Max history entries")
      .setDesc("Maximum number of global history positions to keep in each stack")
      .addText(text =>
        text
          .setPlaceholder("50")
          .setValue(String(this.plugin.settings.maxEntries))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxEntries = num;
              this.plugin.updateMaxEntries(num);
              await this.plugin.saveSettings();
            }
          })
      );

    // Section 3: History Modals
    containerEl.createEl("h3", { text: "History Modals" });

    // 1. Create a fragment
    const descFragment = document.createDocumentFragment();

    // 2. Append text and HTML elements (like <br> for line breaks)
    descFragment.append(
      "Choose which modal opens initially when running 'Open cursor history'. Falls back to global history if 'Current file history' is selected but no file is active.",
      descFragment.createEl("br"),
      descFragment.createEl("br"),
      "Tab: Switch between Current File History and Global History",
      descFragment.createEl("br"),
      "Cmd+Enter (Ctrl+Enter on Windows/Linux): Open in new tab",
      descFragment.createEl("br"),
      "Cmd+-: Open in horizontal split",
      descFragment.createEl("br"),
      "Cmd+I: Open in vertical split",
      descFragment.createEl("br"),
      "Cmd+S: Toggle date display",
      descFragment.createEl("br"),
      "Cmd+L: Clear history",
    );

    // 3. Pass the fragment to setDesc
    new Setting(containerEl)
      .setName("Default history modal")
      .setDesc(descFragment)
      .addDropdown(dropdown =>
        dropdown
          .addOption("current", "Current file history")
          .addOption("global", "Global history")
          .setValue(this.plugin.settings.initialModal ?? "current")
          .onChange(async value => {
            this.plugin.settings.initialModal = value as "current" | "global";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max line length in current file history")
      .setDesc(
        "Maximum line length (characters) to display in current file cursor history modal before ellipsizing",
      )
      .addText(text =>
        text
          .setPlaceholder("120")
          .setValue(String(this.plugin.settings.maxLineLength))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxLineLength = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Edit mode column offset in current file history")
      .setDesc(
        "Number of characters before the cursor column position to start displaying line text in current file cursor history modal",
      )
      .addText(text =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.editColOffset ?? 10))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.editColOffset = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Current file preview fuzz lines")
      .setDesc(
        "Number of lines around the target line to search for a non-empty line to display as preview in current file history modal (0 to disable)",
      )
      .addText(text =>
        text
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.currentFilePreviewFuzzLines ?? 0))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.currentFilePreviewFuzzLines = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // Section 4: Recording Sensitivity & Thresholds
    containerEl.createEl("h3", { text: "Recording Sensitivity & Thresholds" });

    new Setting(containerEl)
      .setName("Edit mode jump threshold (lines)")
      .setDesc("Minimum line difference required to record a new history entry during editing")
      .addText(text =>
        text
          .setPlaceholder("1")
          .setValue(String(this.plugin.settings.editJumpThreshold))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.editJumpThreshold = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Reading mode jump threshold (lines)")
      .setDesc(
        "Minimum line difference required to record a new history entry during reading mode scrolling",
      )
      .addText(text =>
        text
          .setPlaceholder("10")
          .setValue(String(this.plugin.settings.previewJumpThreshold))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.previewJumpThreshold = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Reading mode scroll debounce (ms)")
      .setDesc(
        "Delay in milliseconds to debounce scroll events in Reading mode before recording position",
      )
      .addText(text =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.scrollDebounceMs))
          .onChange(async value => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.scrollDebounceMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // Section 5: Code Block Folding
    containerEl.createEl("h3", { text: "Code Block Folding" });

    new Setting(containerEl)
      .setName("Fold all code blocks by default")
      .setDesc(
        "Automatically fold all rendered code blocks in Reading mode by default (changing this setting clears all stored code block fold history)",
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.codeFoldManager.getFoldAll())
          .onChange(async value => {
            await this.plugin.codeFoldManager.setFoldAll(value);
          })
      );

    new Setting(containerEl)
      .setName("Remember code block fold state")
      .setDesc(
        "Store and restore individual code block fold/unfold states across files in .obsidian/cursor-history/code-fold.json",
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.codeFoldManager.getRememberFoldState())
          .onChange(async value => {
            await this.plugin.codeFoldManager.setRememberFoldState(value);
          })
      );
  }
}
