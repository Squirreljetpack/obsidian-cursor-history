import { App, FuzzyMatch, FuzzySuggestModal, MarkdownView } from "obsidian";
import { HistoryNavigatorModal } from "./history-navigator-modal";
import type CursorHistoryPlugin from "./main";
import { HistoryEntry } from "./navigation-stack";

declare module "obsidian" {
  interface SuggestModal<T> {
    chooser?: {
      values?: any[];
      selectedItem: number;
      setSelectedItem(index: number, evt?: MouseEvent | KeyboardEvent): void;
      updateSuggestions?(): void;
    };
  }
}

export class CurrentFileHistoryModal extends FuzzySuggestModal<HistoryEntry> {
  private plugin: CursorHistoryPlugin;
  private lines: string[] = [];
  private isToggling = false;
  private showDateInModal = false;

  constructor(app: App, plugin: CursorHistoryPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Type to search current file cursor history...");

    this.scope.register([], "Tab", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.toggleToGlobalHistory();
      return false;
    });
    this.scope.register(["Shift"], "Tab", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.toggleToGlobalHistory();
      return false;
    });

    this.scope.register(["Mod"], "l", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.clearHistory();
      return false;
    });
    this.scope.register(["Meta"], "l", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.clearHistory();
      return false;
    });

    this.scope.register(["Mod"], "s", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.toggleShowDate();
      return false;
    });
    this.scope.register(["Meta"], "s", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.toggleShowDate();
      return false;
    });
  }

  private toggleToGlobalHistory(): void {
    if (this.isToggling) return;
    this.isToggling = true;
    this.close();
    new HistoryNavigatorModal(this.app, this.plugin).open();
  }

  private clearHistory(): void {
    this.close();
    void this.plugin.clearCurrentFileHistory();
  }

  private toggleShowDate(): void {
    this.showDateInModal = !this.showDateInModal;
    if (this.chooser && typeof this.chooser.updateSuggestions === "function") {
      this.chooser.updateSuggestions();
    } else if (this.inputEl) {
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  async onOpen(): Promise<void> {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      if (activeView.editor) {
        const content = activeView.editor.getValue();
        this.lines = content.split("\n");
      } else if (activeView.file) {
        const content = await this.app.vault.cachedRead(activeView.file);
        this.lines = content.split("\n");
      } else {
        const content = activeView.getViewData() || activeView.data || "";
        this.lines = content.split("\n");
      }
    } else {
      this.lines = [];
    }
    super.onOpen();

    this.containerEl.addEventListener(
      "keydown",
      (evt: KeyboardEvent) => {
        if (evt.key === "Tab") {
          evt.preventDefault();
          evt.stopPropagation();
          this.toggleToGlobalHistory();
        } else if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === "l") {
          evt.preventDefault();
          evt.stopPropagation();
          this.clearHistory();
        } else if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === "s") {
          evt.preventDefault();
          evt.stopPropagation();
          this.toggleShowDate();
        }
      },
      true,
    );

    this.scrollToCurrentIndex();
  }

  private scrollToCurrentIndex(): void {
    const mode = this.getCurrentMode();
    const current = this.plugin.getCurrentState() ?? this.plugin.getNavStack().getCurrent(mode);
    if (!current || !this.chooser?.values) return;

    const index = this.chooser.values.findIndex((item) => {
      const entry = (item as any).item ?? item;
      return (
        entry === current
        || (entry.filePath === current.filePath
          && entry.mode === current.mode
          && entry.timestamp === current.timestamp)
      );
    });

    if (index !== -1) {
      this.chooser.setSelectedItem(index);
    }
  }

  private getCurrentMode(): "edit" | "preview" {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const mode = activeView.getMode();
      return mode === "source" ? "edit" : "preview";
    }
    return "preview";
  }

  getItems(): HistoryEntry[] {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) return [];

    const mode = this.getCurrentMode();
    const stack = this.plugin.getNavStack().getStackForFile(activeView.file.path, mode);
    return stack.slice().reverse();
  }

  private getPreviewLine(targetLineIndex: number): string {
    const fuzz = Math.max(0, this.plugin.settings.currentFilePreviewFuzzLines ?? 0);
    const targetLine = this.lines[targetLineIndex] ?? "";
    if (targetLine.trim() !== "" || fuzz === 0) {
      return targetLine;
    }
    for (let d = 1; d <= fuzz; d++) {
      for (const idx of [targetLineIndex + d, targetLineIndex - d]) {
        const line = this.lines[idx];
        if (line?.trim()) return line;
      }
    }
    return targetLine;
  }

  getItemText(item: HistoryEntry): string {
    let lineNum = 1;
    if (item.mode === "edit") {
      lineNum = item.selection.startLine + 1;
    } else {
      const scrollLine = item.selection.scrollLine ?? 0;
      if (scrollLine > 0) {
        lineNum = Math.floor(scrollLine) + 1;
      } else if (item.selection.scrollTop > 10) {
        lineNum = Math.floor(item.selection.scrollTop / 24) + 1;
      } else {
        lineNum = 1;
      }
    }
    const lineIndex = lineNum - 1;
    const rawLine = this.getPreviewLine(lineIndex);
    let lineContent = "";

    if (item.mode === "edit") {
      const col = item.selection.startCol ?? 0;
      const offset = this.plugin.settings.editColOffset ?? 10;
      const startIndex = Math.max(0, col - offset);
      lineContent = rawLine.substring(startIndex);
      if (startIndex > 0) {
        lineContent = "..." + lineContent;
      }
      if (!lineContent.trim() && rawLine.trim()) {
        lineContent = rawLine.trim();
      }
    } else {
      lineContent = rawLine.trim();
    }

    if (lineContent) {
      const maxLen = this.plugin.settings.maxLineLength ?? 120;
      if (lineContent.length > maxLen) {
        lineContent = lineContent.substring(0, maxLen) + "...";
      }
      return `${lineNum}: ${lineContent}`;
    }
    return `${lineNum}: `;
  }

  renderSuggestion(match: FuzzyMatch<HistoryEntry>, el: HTMLElement): void {
    super.renderSuggestion(match, el);
    if (this.showDateInModal && match.item.timestamp) {
      let contentEl = el.querySelector(".cursor-history-modal-content") as HTMLElement | null;
      if (!contentEl) {
        contentEl = document.createElement("div");
        contentEl.className = "cursor-history-modal-content";
        while (el.firstChild) {
          contentEl.appendChild(el.firstChild);
        }
        el.appendChild(contentEl);
      }
      contentEl.style.flex = "1 1 auto";
      contentEl.style.minWidth = "0";

      el.style.display = "flex";
      el.style.flexWrap = "wrap";
      el.style.justifyContent = "space-between";
      el.style.alignItems = "center";
      el.style.gap = "2px 8px";

      const dateStr = new Date(match.item.timestamp).toLocaleString();
      const dateEl = el.createEl("span", {
        text: dateStr,
        cls: "cursor-history-modal-date",
      });
      dateEl.style.color = "var(--text-muted, gray)";
      dateEl.style.fontSize = "0.8em";
      dateEl.style.whiteSpace = "nowrap";
      dateEl.style.marginLeft = "auto";
      dateEl.style.textAlign = "right";
    }
  }

  onChooseItem(item: HistoryEntry, evt: MouseEvent | KeyboardEvent): void {
    void this.plugin.navigateTo(item);
  }
}
