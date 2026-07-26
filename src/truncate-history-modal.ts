import { App, Modal, Notice, Setting } from "obsidian";
import type CursorHistoryPlugin from "./main";

export class TruncateHistoryModal extends Modal {
  private plugin: CursorHistoryPlugin;
  private value = "0";

  constructor(app: App, plugin: CursorHistoryPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Truncate Cursor History" });

    new Setting(contentEl)
      .setName("Number of entries to keep (N)")
      .setDesc("Enter 0 to clear all history, or N to keep the N most recent entries.")
      .addText((text) => {
        text.setValue(this.value);
        text.onChange((val) => {
          this.value = val;
        });
        text.inputEl.focus();
        text.inputEl.select();
        text.inputEl.addEventListener("keydown", (evt: KeyboardEvent) => {
          if (evt.key === "Enter") {
            evt.preventDefault();
            this.submit();
          }
        });
      });

    new Setting(contentEl).addButton((btn) => {
      btn
        .setButtonText("Truncate")
        .setCta()
        .onClick(() => {
          this.submit();
        });
    });
  }

  private submit(): void {
    const n = parseInt(this.value.trim(), 10);
    if (isNaN(n) || n < 0) {
      new Notice("Please enter a valid non-negative number.");
      return;
    }
    void this.plugin.truncateHistory(n);
    this.close();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
