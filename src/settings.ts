import { App, PluginSettingTab, Setting } from "obsidian";
import type CursorHistoryPlugin from "./main";

export interface CursorHistorySettings {
  hotkeyDefaultsApplied: boolean;
  useFolderLocalHistory: boolean;
  restoreScrollPosition: boolean;
  rememberModeOnFileOpen: boolean;
  recordOnFileSwitch: boolean;
  showDateInModal: boolean;
  initialModal: "current" | "global";
  maxEntries: number;
  maxLineLength: number;
  editColOffset: number;
  openRecordDelayMs: number;
  editJumpThreshold: number;
  previewJumpThreshold: number;
  scrollDebounceMs: number;
}

export const DEFAULT_SETTINGS: CursorHistorySettings = {
  hotkeyDefaultsApplied: false,
  useFolderLocalHistory: false,
  restoreScrollPosition: true,
  rememberModeOnFileOpen: false,
  recordOnFileSwitch: false,
  showDateInModal: false,
  initialModal: "current",
  maxEntries: 50,
  maxLineLength: 120,
  editColOffset: 10,
  openRecordDelayMs: 1000,
  editJumpThreshold: 1,
  previewJumpThreshold: 10,
  scrollDebounceMs: 100,
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

    new Setting(containerEl)
      .setName("Use folder local history")
      .setDesc("Save history stack to .obsidian/cursor-history/cursor.json instead of plugin data.json")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.useFolderLocalHistory)
          .onChange(async value => {
            this.plugin.settings.useFolderLocalHistory = value;
            await this.plugin.saveSettingsAndHistory();
          })
      );

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
      .setName("Record position on file switch")
      .setDesc("Record history entries when switching between files or tabs")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.recordOnFileSwitch)
          .onChange(async value => {
            this.plugin.settings.recordOnFileSwitch = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show date in modals")
      .setDesc("Display formatted date/time in gray for entries in history modals")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showDateInModal)
          .onChange(async value => {
            this.plugin.settings.showDateInModal = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default history modal")
      .setDesc(
        "Choose which modal opens initially when running 'Open cursor history'. Falls back to global history if 'Current file history' is selected but no file is active.",
      )
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

    containerEl.createEl("h3", { text: "Modal Shortcuts" });
    new Setting(containerEl)
      .setName("Switch modal mode")
      .setDesc("Press Tab inside any history modal to toggle between Current File History and Global History.");

    new Setting(containerEl)
      .setName("Clear history")
      .setDesc(
        "Press Meta+L (Cmd+L on Mac, Ctrl+L on Windows/Linux) inside a history modal to clear history. On Current File History modal, it clears history for the active file; on Global History modal, it clears all global history.",
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
  }
}
