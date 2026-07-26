import { App, FuzzyMatch, FuzzySuggestModal, TFile } from "obsidian";
import type CursorHistoryPlugin from "./main";

export interface RecentFileItem {
  file: TFile;
  timestamp: number;
}

export class RecentFilesModal extends FuzzySuggestModal<RecentFileItem> {
  private plugin: CursorHistoryPlugin;

  constructor(app: App, plugin: CursorHistoryPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Type to search recently opened files...");

    this.scope.register(["Meta"], "s", (evt: KeyboardEvent) => {
      evt.preventDefault();
      void this.toggleShowDate();
      return false;
    });
    this.scope.register(["Mod"], "s", (evt: KeyboardEvent) => {
      evt.preventDefault();
      void this.toggleShowDate();
      return false;
    });
  }

  onOpen(): void {
    super.onOpen();
    this.containerEl.addEventListener(
      "keydown",
      (evt: KeyboardEvent) => {
        if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === "s") {
          evt.preventDefault();
          evt.stopPropagation();
          void this.toggleShowDate();
        }
      },
      true
    );
  }

  private async toggleShowDate(): Promise<void> {
    this.plugin.settings.showDateInModal = !this.plugin.settings.showDateInModal;
    await this.plugin.saveSettings();
    if (typeof (this as any).updateSuggestions === "function") {
      (this as any).updateSuggestions();
    } else if (this.inputEl) {
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  getItems(): RecentFileItem[] {
    return this.plugin.getRecentlyOpenedFiles();
  }

  getItemText(item: RecentFileItem): string {
    const path = item.file.path;
    return path.endsWith(".md") ? path.slice(0, -3) : path;
  }

  renderSuggestion(match: FuzzyMatch<RecentFileItem>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    if (this.plugin.settings.showDateInModal && match.item.timestamp) {
      el.style.display = "flex";
      el.style.justifyContent = "space-between";
      el.style.alignItems = "center";
      const dateStr = new Date(match.item.timestamp).toLocaleString();
      const dateEl = el.createEl("span", {
        text: dateStr,
        cls: "cursor-history-modal-date",
      });
      dateEl.style.color = "var(--text-muted, gray)";
      dateEl.style.fontSize = "0.8em";
      dateEl.style.marginLeft = "10px";
      dateEl.style.whiteSpace = "nowrap";
    }
  }

  onChooseItem(item: RecentFileItem, evt: MouseEvent | KeyboardEvent): void {
    void this.plugin.openRecentFile(item.file);
  }
}
