import { App, FuzzyMatch, FuzzySuggestModal, MarkdownView } from "obsidian";
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
        } else if ((evt.metaKey || evt.ctrlKey) && evt.key.toLowerCase() === "l") {
          evt.preventDefault();
          evt.stopPropagation();
          this.clearHistory();
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

  onChooseItem(item: HistoryEntry, evt: MouseEvent | KeyboardEvent): void {
    void this.plugin.navigateTo(item);
  }
}
