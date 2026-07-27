import { App, FuzzyMatch, FuzzySuggestModal, MarkdownView, PaneType, SplitDirection } from "obsidian";
import type CursorHistoryPlugin from "./main";
import { CurrentFileHistoryModal } from "./current-file-history-modal";
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

export class HistoryNavigatorModal extends FuzzySuggestModal<HistoryEntry> {
  private plugin: CursorHistoryPlugin;
  private isToggling = false;
  private showDateInModal = false;

  constructor(app: App, plugin: CursorHistoryPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder("Type to search cursor history...");

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      this.scope.register([], "Tab", (evt: KeyboardEvent) => {
        evt.preventDefault();
        this.toggleToCurrentFileHistory();
        return false;
      });
      this.scope.register(["Shift"], "Tab", (evt: KeyboardEvent) => {
        evt.preventDefault();
        this.toggleToCurrentFileHistory();
        return false;
      });
    }

    this.scope.register(["Mod"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.chooseSelectedItem("tab");
      return false;
    });
    this.scope.register(["Meta"], "Enter", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.chooseSelectedItem("tab");
      return false;
    });

    this.scope.register(["Mod"], "-", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.chooseSelectedItem("split", "horizontal");
      return false;
    });
    this.scope.register(["Meta"], "-", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.chooseSelectedItem("split", "horizontal");
      return false;
    });

    this.scope.register(["Mod"], "i", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.chooseSelectedItem("split", "vertical");
      return false;
    });
    this.scope.register(["Meta"], "i", (evt: KeyboardEvent) => {
      evt.preventDefault();
      this.chooseSelectedItem("split", "vertical");
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

  private getSelectedItem(): HistoryEntry | null {
    if (!this.chooser || !this.chooser.values || this.chooser.values.length === 0) return null;
    const selected = this.chooser.values[this.chooser.selectedItem];
    if (!selected) return null;
    return (selected.item ?? selected) as HistoryEntry;
  }

  private chooseSelectedItem(newLeaf?: PaneType | boolean, direction?: SplitDirection): void {
    const item = this.getSelectedItem();
    if (!item) return;
    this.close();
    void this.plugin.navigateTo(item, newLeaf, direction);
  }

  private toggleToCurrentFileHistory(): void {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) return;

    if (this.isToggling) return;
    this.isToggling = true;
    this.close();
    new CurrentFileHistoryModal(this.app, this.plugin).open();
  }

  private clearHistory(): void {
    this.close();
    void this.plugin.clearGlobalHistory();
  }

  private toggleShowDate(): void {
    this.showDateInModal = !this.showDateInModal;
    if (this.chooser && typeof this.chooser.updateSuggestions === "function") {
      this.chooser.updateSuggestions();
    } else if (this.inputEl) {
      this.inputEl.dispatchEvent(new Event("input"));
    }
  }

  private getCurrentMode(): "edit" | "preview" {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView) {
      const mode = activeView.getMode();
      return mode === "source" ? "edit" : "preview";
    }
    // Default to read mode if no active markdown view detected
    return "preview";
  }

  getItems(): HistoryEntry[] {
    const mode = this.getCurrentMode();
    const stack = this.plugin.getNavStack().getStack(mode);
    return stack.slice().reverse();
  }

  onOpen(): void {
    super.onOpen();

    this.containerEl.addEventListener(
      "keydown",
      (evt: KeyboardEvent) => {
        if (evt.key === "Tab") {
          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (activeView && activeView.file) {
            evt.preventDefault();
            evt.stopPropagation();
            this.toggleToCurrentFileHistory();
          }
        } else if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
          evt.preventDefault();
          evt.stopPropagation();
          this.chooseSelectedItem("tab");
        } else if (
          (evt.metaKey || evt.ctrlKey) &&
          (evt.key === "-" || evt.code === "Minus" || evt.code === "NumpadSubtract")
        ) {
          evt.preventDefault();
          evt.stopPropagation();
          this.chooseSelectedItem("split", "horizontal");
        } else if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === "i") {
          evt.preventDefault();
          evt.stopPropagation();
          this.chooseSelectedItem("split", "vertical");
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
      true
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
        entry === current ||
        (entry.filePath === current.filePath &&
          entry.mode === current.mode &&
          entry.timestamp === current.timestamp)
      );
    });

    if (index !== -1) {
      this.chooser.setSelectedItem(index);
    }
  }

  getItemText(item: HistoryEntry): string {
    let line = 1;
    if (item.mode === "edit") {
      line = item.selection.startLine + 1;
    } else {
      const scrollLine = item.selection.scrollLine ?? 0;
      if (scrollLine > 0) {
        line = Math.floor(scrollLine) + 1;
      } else if (item.selection.scrollTop > 10) {
        line = Math.floor(item.selection.scrollTop / 24) + 1;
      } else {
        line = 1;
      }
    }
    return `${line}: ${item.filePath}`;
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
    let newLeaf: PaneType | boolean | undefined;
    let direction: SplitDirection | undefined;

    if (evt && (evt.metaKey || evt.ctrlKey)) {
      if (evt instanceof KeyboardEvent && (evt.key === "-" || evt.code === "Minus" || evt.code === "NumpadSubtract")) {
        newLeaf = "split";
        direction = "horizontal";
      } else if (evt instanceof KeyboardEvent && evt.key.toLowerCase() === "i") {
        newLeaf = "split";
        direction = "vertical";
      } else {
        newLeaf = "tab";
      }
    }

    void this.plugin.navigateTo(item, newLeaf, direction);
  }
}
