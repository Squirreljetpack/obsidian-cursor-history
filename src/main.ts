import { Extension } from "@codemirror/state";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { CodeFoldManager } from "./code-fold-manager";
import { CurrentFileHistoryModal } from "./current-file-history-modal";
import { HistoryNavigatorModal } from "./history-navigator-modal";
import { RecentFileItem, RecentFilesModal } from "./recent-files-modal";
import {
  EditHistoryEntry,
  FileHistoryMap,
  FileLastPositions,
  HistoryEntry,
  NavigationStack,
  PreviewHistoryEntry,
  PreviewSelection,
} from "./navigation-stack";
import { shouldCreateNewEntry } from "./selection-state";
import { CursorHistorySettings, CursorHistorySettingTab, DEFAULT_SETTINGS } from "./settings";

// --- Obsidian type augmentation for undocumented APIs ---

interface ObsidianHotkey {
  modifiers: string[];
  key: string;
}

declare module "obsidian" {
  interface App {
    hotkeyManager: {
      getHotkeys(id: string): ObsidianHotkey[] | undefined;
      getDefaultHotkeys(id: string): ObsidianHotkey[];
      load(): Promise<void>;
    };
  }
  interface MarkdownPreviewView {
    getScroll(): number;
    applyScroll(scrollLine: number): void;
    containerEl: HTMLElement;
  }
}

const DESIRED_HOTKEYS: Record<string, ObsidianHotkey> = {
  "cursor-history:go-back": { modifiers: ["Mod"], key: "[" },
  "cursor-history:go-forward": { modifiers: ["Mod"], key: "]" },
};

export default class CursorHistoryPlugin extends Plugin {
  settings: CursorHistorySettings = DEFAULT_SETTINGS;
  private navStack = new NavigationStack(50);
  private fileLastPositions = new Map<string, FileLastPositions>();
  private currentState: HistoryEntry | null = null;
  private isNavigating = false;
  private hotkeyExtension: Extension[] = [];
  private saveTimeoutId: number | null = null;
  private lastActiveLeaf: WorkspaceLeaf | null = null;
  public codeFoldManager = new CodeFoldManager(this);

  async onload() {
    await this.loadSettings();
    await this.codeFoldManager.init();

    this.addSettingTab(new CursorHistorySettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "toggle-fold-all-code-blocks",
      name: "Toggle fold all code blocks",
      callback: () => {
        void this.codeFoldManager.toggleFoldAllCurrentFile();
      },
    });
    this.addCommand({
      id: "go-back",
      name: "Go back",
      hotkeys: [{ modifiers: ["Mod"], key: "[" }],
      callback: () => void this.goBack(),
    });

    this.addCommand({
      id: "go-forward",
      name: "Go forward",
      hotkeys: [{ modifiers: ["Mod"], key: "]" }],
      callback: () => void this.goForward(),
    });

    this.addCommand({
      id: "open-cursor-history",
      name: "Open cursor history",
      callback: () => {
        new HistoryNavigatorModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "open-recently-opened-files",
      name: "Open recently opened files",
      callback: () => {
        new RecentFilesModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "open-current-file-cursor-history",
      name: "Open current file cursor history",
      callback: () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) {
          new Notice("No active file to show cursor history.");
          return;
        }
        new CurrentFileHistoryModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: "clear-current-file-history",
      name: "Clear current file cursor history",
      callback: async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || !view.file) {
          new Notice("No active file to clear history.");
          return;
        }

        const filePath = view.file.path;
        const mode = view.getMode();

        if (mode === "source") {
          this.navStack.clearForFile(filePath, "edit");
          const pos = this.fileLastPositions.get(filePath);
          if (pos) {
            delete pos.edit;
            if (!pos.edit && !pos.preview) this.fileLastPositions.delete(filePath);
          }
          if (this.currentState && this.currentState.filePath === filePath && this.currentState.mode === "edit") {
            this.currentState = null;
          }
          await this.saveHistoryStackImmediate();
          new Notice(`Cleared edit cursor history for ${view.file.basename}`);
        } else {
          await this.codeFoldManager.clearFileFoldHistory(filePath);
          this.navStack.clearForFile(filePath, "preview");
          const pos = this.fileLastPositions.get(filePath);
          if (pos) {
            delete pos.preview;
            if (!pos.edit && !pos.preview) this.fileLastPositions.delete(filePath);
          }
          if (this.currentState && this.currentState.filePath === filePath && this.currentState.mode === "preview") {
            this.currentState = null;
          }
          await this.saveHistoryStackImmediate();
          new Notice(`Cleared code fold and preview history for ${view.file.basename}`);
        }
      },
    });

    // Capturing phase DOM click listener for internal links & Reading View clicks
    this.registerDomEvent(
      document,
      "click",
      (evt: MouseEvent) => {
        const target = evt.target as HTMLElement | null;
        const linkEl = target?.closest("a.internal-link");
        if (linkEl) {
          this.recordCurrentPosition();
          return;
        }
        this.handleReadingViewClick(evt);
      },
      true, // useCapture phase
    );

    // Capturing phase DOM scroll listener for Reading View scrolling
    this.registerDomEvent(
      document,
      "scroll",
      (evt: Event) => {
        const target = evt.target as HTMLElement | null;
        if (target && target.classList && target.classList.contains("markdown-preview-view")) {
          this.handleReadingViewScroll();
        }
      },
      true, // useCapture phase
    );

    // Listen for workspace leaf changes (tab switch / note navigation)
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (this.isNavigating) return;

        if (this.settings.recordOnFileSwitch) {
          if (this.lastActiveLeaf && this.lastActiveLeaf !== leaf) {
            this.recordPositionForLeaf(this.lastActiveLeaf);
          }
          this.recordCurrentPosition();
        }
        this.lastActiveLeaf = leaf;
      }),
    );

    // Listen for file opening in normal way to restore position from DB
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || this.isNavigating || !this.settings.restoreScrollPosition) return;

        const dbRecord = this.fileLastPositions.get(file.path);
        if (!dbRecord) return;

        setTimeout(() => {
          void this.restorePositionForOpenFile(file.path, dbRecord);
        }, 50);
      }),
    );

    // Listen for cursor changes within CM6 editors (Edit Mode)
    this.registerEditorExtension(
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (this.isNavigating) return;
        if (!update.selectionSet) return;

        this.recordCurrentPosition();
      }),
    );

    // Keymaps for key-repeat support
    this.registerEditorExtension(this.hotkeyExtension);
    this.app.workspace.onLayoutReady(async () => {
      await this.applyDefaultHotkeys();
      this.buildKeymap();
    });
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.buildKeymap()),
    );
  }

  async onunload() {
    await this.saveHistoryStackImmediate();
  }

  getNavStack(): NavigationStack {
    return this.navStack;
  }

  public getRecentlyOpenedFiles(): RecentFileItem[] {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activePath = activeView?.file?.path;

    const timestamps = new Map<string, number>();

    for (const [filePath, pos] of this.fileLastPositions.entries()) {
      if (activePath && filePath === activePath) continue;
      const editTs = pos.edit?.timestamp ?? 0;
      const previewTs = pos.preview?.timestamp ?? 0;
      const maxTs = Math.max(editTs, previewTs);
      if (maxTs > 0) {
        timestamps.set(filePath, maxTs);
      }
    }

    const stack = this.navStack.getStack();
    for (const entry of stack) {
      if (activePath && entry.filePath === activePath) continue;
      const currentMax = timestamps.get(entry.filePath) ?? 0;
      const ts = entry.timestamp ?? 0;
      if (ts > currentMax) {
        timestamps.set(entry.filePath, ts);
      }
    }

    const sortedPaths = Array.from(timestamps.keys()).sort((a, b) => {
      return (timestamps.get(b) ?? 0) - (timestamps.get(a) ?? 0);
    });

    const result: RecentFileItem[] = [];
    for (const path of sortedPaths) {
      if (this.isValidFilePath(path)) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          const timestamp = timestamps.get(path) ?? file.stat.mtime;
          result.push({ file, timestamp });
        }
      }
    }

    return result;
  }

  public async openRecentFile(file: TFile): Promise<void> {
    const navEntry = this.navStack.findLatestForFile(file.path);
    if (navEntry) {
      await this.navigateTo(navEntry);
      return;
    }

    const dbRecord = this.fileLastPositions.get(file.path);
    if (dbRecord) {
      const editTs = dbRecord.edit?.timestamp ?? -1;
      const previewTs = dbRecord.preview?.timestamp ?? -1;
      if (editTs >= 0 || previewTs >= 0) {
        const mode = editTs >= previewTs ? "edit" : "preview";
        const pos = mode === "edit" ? dbRecord.edit! : dbRecord.preview!;
        const entry: HistoryEntry = {
          mode,
          filePath: file.path,
          selection: pos.selection as any,
          timestamp: pos.timestamp,
        };
        await this.navigateTo(entry);
        return;
      }
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  updateMaxEntries(size: number): void {
    this.navStack.setMaxSize(size);
  }

  async loadSettings(): Promise<void> {
    const rawData = (await this.loadData()) || {};
    if (typeof rawData.jumpThreshold === "number") {
      rawData.previewJumpThreshold = rawData.previewJumpThreshold ?? rawData.jumpThreshold;
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData);
    this.navStack.setMaxSize(this.settings.maxEntries);
    await this.loadHistoryStack();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSettingsAndHistory(): Promise<void> {
    await this.saveSettings();
    await this.saveHistoryStackImmediate();
  }

  private getHistoryFilePath(): string {
    return `${this.app.vault.configDir}/cursor-history/cursor.json`;
  }

  private async ensureHistoryDirectoryExists(): Promise<void> {
    const dir = `${this.app.vault.configDir}/cursor-history`;
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
  }

  private isValidFilePath(filePath: string): boolean {
    if (!filePath || typeof filePath !== "string") return false;
    if (filePath.startsWith("!") || filePath.includes("![[")) return false;
    if (filePath.includes("..") || filePath.includes("\0")) return false;

    const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
    return abstractFile instanceof TFile && abstractFile.extension === "md";
  }

  private cleanupInvalidDbEntries(): void {
    this.navStack.purgeInvalid(this.isValidFilePath.bind(this));
    for (const filePath of Array.from(this.fileLastPositions.keys())) {
      if (!this.isValidFilePath(filePath)) {
        this.fileLastPositions.delete(filePath);
      }
    }
  }

  private async restorePositionForOpenFile(filePath: string, dbRecord: FileLastPositions): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== filePath) return;

    let targetMode: "edit" | "preview" | null = null;

    if (this.settings.rememberModeOnFileOpen) {
      const editTs = dbRecord.edit ? dbRecord.edit.timestamp : -1;
      const previewTs = dbRecord.preview ? dbRecord.preview.timestamp : -1;

      if (editTs >= 0 || previewTs >= 0) {
        targetMode = editTs >= previewTs ? "edit" : "preview";
      }
    } else {
      const currentViewMode = view.getMode();
      targetMode = currentViewMode === "source" ? "edit" : "preview";
    }

    if (!targetMode) return;

    if (this.settings.rememberModeOnFileOpen) {
      const currentObsidianMode = view.getMode();
      const desiredObsidianMode = targetMode === "edit" ? "source" : "preview";
      if (currentObsidianMode !== desiredObsidianMode) {
        await view.setState({ mode: desiredObsidianMode }, { history: false });
      }
    }

    if (targetMode === "edit" && dbRecord.edit) {
      const entry: HistoryEntry = {
        mode: "edit",
        filePath,
        selection: dbRecord.edit.selection,
        timestamp: dbRecord.edit.timestamp,
      };
      await this.navigateTo(entry, true);
    } else if (targetMode === "preview" && dbRecord.preview) {
      const entry: HistoryEntry = {
        mode: "preview",
        filePath,
        selection: dbRecord.preview.selection,
        timestamp: dbRecord.preview.timestamp,
      };
      await this.navigateTo(entry, true);
    }
  }

  private async loadHistoryStack(): Promise<void> {
    let rawContent: any = null;
    this.fileLastPositions.clear();

    if (this.settings.useFolderLocalHistory) {
      const path = this.getHistoryFilePath();
      try {
        if (await this.app.vault.adapter.exists(path)) {
          const content = await this.app.vault.adapter.read(path);
          rawContent = JSON.parse(content);
        }
      } catch (err) {
        console.error("Cursor History: Error reading folder local history file:", err);
      }
    } else {
      const rawData = (await this.loadData()) || {};
      rawContent = rawData.historyStack;
    }

    if (Array.isArray(rawContent)) {
      for (const entry of rawContent as HistoryEntry[]) {
        if (entry && entry.filePath && entry.selection) {
          const filePos = this.fileLastPositions.get(entry.filePath) || {};
          const ts = entry.timestamp || Date.now();
          if (entry.mode === "edit") {
            if (!filePos.edit || ts >= filePos.edit.timestamp) {
              filePos.edit = { selection: entry.selection, timestamp: ts };
            }
          } else if (entry.mode === "preview") {
            if (!filePos.preview || ts >= filePos.preview.timestamp) {
              filePos.preview = { selection: entry.selection, timestamp: ts };
            }
          }
          this.fileLastPositions.set(entry.filePath, filePos);
        }
      }
    } else if (rawContent && typeof rawContent === "object") {
      for (const [filePath, value] of Object.entries(rawContent)) {
        if (Array.isArray(value)) {
          const filePos: FileLastPositions = {};
          for (const item of value) {
            if (item && item.mode && item.selection) {
              const ts = item.timestamp || Date.now();
              if (item.mode === "edit") {
                if (!filePos.edit || ts >= filePos.edit.timestamp) {
                  filePos.edit = { selection: item.selection, timestamp: ts };
                }
              } else if (item.mode === "preview") {
                if (!filePos.preview || ts >= filePos.preview.timestamp) {
                  filePos.preview = { selection: item.selection, timestamp: ts };
                }
              }
            }
          }
          if (filePos.edit || filePos.preview) {
            this.fileLastPositions.set(filePath, filePos);
          }
        } else if (value && typeof value === "object") {
          const val = value as any;
          if (val.edit || val.preview) {
            const filePos: FileLastPositions = {};
            if (val.edit && val.edit.selection) {
              filePos.edit = {
                selection: val.edit.selection,
                timestamp: val.edit.timestamp || Date.now(),
              };
            }
            if (val.preview && val.preview.selection) {
              filePos.preview = {
                selection: val.preview.selection,
                timestamp: val.preview.timestamp || Date.now(),
              };
            }
            this.fileLastPositions.set(filePath, filePos);
          } else if (val.mode && val.selection) {
            const filePos: FileLastPositions = {};
            const ts = val.timestamp || Date.now();
            if (val.mode === "edit") {
              filePos.edit = { selection: val.selection, timestamp: ts };
            } else if (val.mode === "preview") {
              filePos.preview = { selection: val.selection, timestamp: ts };
            }
            this.fileLastPositions.set(filePath, filePos);
          }
        }
      }
    }

    // Note: In-memory NavigationStack starts empty upon startup as requested.
    this.navStack.setStack([]);
    this.cleanupInvalidDbEntries();
  }

  private scheduleHistorySave(): void {
    if (this.saveTimeoutId !== null) {
      window.clearTimeout(this.saveTimeoutId);
    }
    this.saveTimeoutId = window.setTimeout(() => {
      this.saveTimeoutId = null;
      void this.saveHistoryStackImmediate();
    }, 2000);
  }

  private async saveHistoryStackImmediate(): Promise<void> {
    if (this.saveTimeoutId !== null) {
      window.clearTimeout(this.saveTimeoutId);
      this.saveTimeoutId = null;
    }

    this.cleanupInvalidDbEntries();

    const fileMap: FileHistoryMap = {};
    for (const [filePath, pos] of this.fileLastPositions.entries()) {
      fileMap[filePath] = pos;
    }

    if (this.settings.useFolderLocalHistory) {
      const path = this.getHistoryFilePath();
      try {
        await this.ensureHistoryDirectoryExists();
        await this.app.vault.adapter.write(path, JSON.stringify(fileMap, null, 2));
      } catch (err) {
        console.error("Cursor History: Error writing folder local history file:", err);
      }
    } else {
      const rawData = (await this.loadData()) || {};
      rawData.historyStack = fileMap;
      await this.saveData(rawData);
    }
  }

  private previewScrollTimeoutId: number | null = null;

  private getClickedLineFromElement(target: HTMLElement | null): number | null {
    let el: HTMLElement | null = target;
    while (el && !el.classList.contains("markdown-preview-view")) {
      const dataLine = el.getAttribute("data-line");
      if (dataLine !== null && dataLine !== "") {
        const num = parseInt(dataLine, 10);
        if (!isNaN(num)) return num;
      }

      if (el.dataset && el.dataset.line) {
        const num = parseInt(el.dataset.line, 10);
        if (!isNaN(num)) return num;
      }

      const sec = (el as any).sectionInfo || (el as any).SectionInfo;
      if (sec && typeof sec.lineStart === "number") {
        return sec.lineStart;
      }
      if (sec && typeof sec.line === "number") {
        return sec.line;
      }

      el = el.parentElement;
    }
    return null;
  }

  private handleReadingViewClick(evt: MouseEvent): void {
    const target = evt.target as HTMLElement | null;
    if (!target || !target.closest(".markdown-preview-view")) return;
    if (target.closest("a.internal-link, button, input, textarea, select")) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.getMode() !== "preview" || !view.file) return;

    const clickedLine = this.getClickedLineFromElement(target);
    if (clickedLine === null) return;

    const previewEl = view.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null;
    const scrollTop = previewEl ? previewEl.scrollTop : 0;

    const entry: PreviewHistoryEntry = {
      mode: "preview",
      filePath: view.file.path,
      selection: {
        scrollTop,
        scrollLine: clickedLine,
      },
      timestamp: Date.now(),
    };

    if (
      shouldCreateNewEntry(
        this.currentState,
        entry,
        this.settings.editJumpThreshold,
        this.settings.previewJumpThreshold,
      )
    ) {
      this.navStack.push(entry);
    } else {
      this.navStack.replaceCurrent(entry);
    }

    let filePos = this.fileLastPositions.get(entry.filePath);
    if (!filePos) {
      filePos = {};
      this.fileLastPositions.set(entry.filePath, filePos);
    }
    filePos.preview = { selection: entry.selection, timestamp: entry.timestamp };

    this.currentState = entry;
    this.scheduleHistorySave();
  }

  private handleReadingViewScroll(): void {
    if (this.isNavigating) return;

    if (this.previewScrollTimeoutId !== null) {
      window.clearTimeout(this.previewScrollTimeoutId);
    }

    this.previewScrollTimeoutId = window.setTimeout(() => {
      this.previewScrollTimeoutId = null;
      this.recordCurrentPosition();
    }, this.settings.scrollDebounceMs ?? 100);
  }

  private recordCurrentPosition(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;
    this.recordPositionForView(view);
  }

  private recordPositionForLeaf(leaf: WorkspaceLeaf): void {
    if (leaf.view instanceof MarkdownView && leaf.view.file) {
      this.recordPositionForView(leaf.view);
    }
  }

  private recordPositionForView(view: MarkdownView): void {
    const entry = this.getEntryForView(view);
    if (!entry) return;

    if (!this.isValidFilePath(entry.filePath)) return;

    if (
      shouldCreateNewEntry(
        this.currentState,
        entry,
        this.settings.editJumpThreshold,
        this.settings.previewJumpThreshold,
      )
    ) {
      this.navStack.push(entry);
    } else {
      this.navStack.replaceCurrent(entry);
    }

    let filePos = this.fileLastPositions.get(entry.filePath);
    if (!filePos) {
      filePos = {};
      this.fileLastPositions.set(entry.filePath, filePos);
    }
    const ts = entry.timestamp || Date.now();
    if (entry.mode === "edit") {
      filePos.edit = { selection: entry.selection, timestamp: ts };
    } else {
      filePos.preview = { selection: entry.selection, timestamp: ts };
    }

    this.currentState = entry;
    this.scheduleHistorySave();
  }

  private getEntryForView(view: MarkdownView): HistoryEntry | null {
    if (!view?.file) return null;
    const mode = view.getMode();

    if (mode === "preview") {
      const previewView = view.previewMode;
      const scrollLine = typeof previewView.getScroll === "function" ? previewView.getScroll() : 0;
      const previewEl = view.contentEl.querySelector(".markdown-preview-view");
      const scrollTop = previewEl ? previewEl.scrollTop : 0;

      const entry: PreviewHistoryEntry = {
        mode: "preview",
        filePath: view.file.path,
        selection: {
          scrollTop,
          scrollLine,
        },
        timestamp: Date.now(),
      };
      return entry;
    } else {
      const editor = view.editor;
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");

      const entry: EditHistoryEntry = {
        mode: "edit",
        filePath: view.file.path,
        selection: {
          startLine: from.line,
          startCol: from.ch,
          endLine: to.line,
          endCol: to.ch,
        },
        timestamp: Date.now(),
      };
      return entry;
    }
  }

  private async applyDefaultHotkeys() {
    if (this.settings.hotkeyDefaultsApplied) return;

    const configPath = `${this.app.vault.configDir}/hotkeys.json`;
    let hotkeys: Record<string, ObsidianHotkey[]> = {};

    try {
      hotkeys = JSON.parse(await this.app.vault.adapter.read(configPath));
    } catch {
      // File doesn't exist or is invalid
    }

    let changed = false;
    for (const [cmdId, hk] of Object.entries(DESIRED_HOTKEYS)) {
      if (hotkeys[cmdId]) continue;
      hotkeys[cmdId] = [hk];
      changed = true;
    }

    if (changed) {
      await this.app.vault.adapter.write(configPath, JSON.stringify(hotkeys, null, "  "));
      if (typeof this.app.hotkeyManager?.load === "function") {
        await this.app.hotkeyManager.load();
      }
    }

    this.settings.hotkeyDefaultsApplied = true;
    await this.saveSettings();
  }

  private buildKeymap(): void {
    const backKeys = this.getCommandHotkeys("cursor-history:go-back");
    const forwardKeys = this.getCommandHotkeys("cursor-history:go-forward");

    const bindings: Array<{ key: string; run: () => boolean }> = [];

    for (const hk of backKeys) {
      bindings.push({
        key: [...hk.modifiers, hk.key].join("-"),
        run: () => {
          void this.goBack();
          return true;
        },
      });
    }

    for (const hk of forwardKeys) {
      bindings.push({
        key: [...hk.modifiers, hk.key].join("-"),
        run: () => {
          void this.goForward();
          return true;
        },
      });
    }

    this.hotkeyExtension.length = 0;
    if (bindings.length > 0) {
      this.hotkeyExtension.push(keymap.of(bindings));
    }
    this.app.workspace.updateOptions();
  }

  private getCommandHotkeys(commandId: string): ObsidianHotkey[] {
    const hm = this.app.hotkeyManager;
    if (!hm) return [];

    const custom = hm.getHotkeys(commandId);
    if (custom !== undefined) return custom;
    return hm.getDefaultHotkeys(commandId) || [];
  }

  private getCurrentMode(): "edit" | "preview" {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      return view.getMode() === "source" ? "edit" : "preview";
    }
    return "preview";
  }

  private isCursorInView(view: MarkdownView): boolean {
    const editor = view.editor;
    const cm = (editor as any).cm;
    if (cm && cm.viewport && cm.state && cm.state.doc) {
      const cursorLine = editor.getCursor("from").line;
      const startLine = cm.state.doc.lineAt(cm.viewport.from).number - 1;
      const endLine = cm.state.doc.lineAt(cm.viewport.to).number - 1;
      return cursorLine >= startLine && cursorLine <= endLine;
    }

    return true;
  }

  private async goBack(): Promise<void> {
    const mode = this.getCurrentMode();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);

    if (view && mode === "edit") {
      if (!this.isCursorInView(view)) {
        const cursor = view.editor.getCursor("from");
        view.editor.scrollIntoView({ from: cursor, to: cursor }, true);
        const current = this.getEntryForView(view);
        if (current) this.currentState = current;
        return;
      }
    }

    if (view) {
      const current = this.getEntryForView(view);
      if (
        current
        && shouldCreateNewEntry(
          this.currentState,
          current,
          this.settings.editJumpThreshold,
          this.settings.previewJumpThreshold,
        )
      ) {
        this.navStack.push(current);
        this.currentState = current;
      }
    }

    const entry = this.navStack.goBack(mode);
    if (entry) await this.navigateTo(entry);
  }

  private async goForward(): Promise<void> {
    const mode = this.getCurrentMode();
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      const current = this.getEntryForView(view);
      if (
        current
        && shouldCreateNewEntry(
          this.currentState,
          current,
          this.settings.editJumpThreshold,
          this.settings.previewJumpThreshold,
        )
      ) {
        this.navStack.push(current);
        this.currentState = current;
      }
    }

    const entry = this.navStack.goForward(mode);
    if (entry) await this.navigateTo(entry);
  }

  public async navigateTo(entry: HistoryEntry, isAutoRestore = false): Promise<void> {
    this.isNavigating = true;

    try {
      const file = this.app.vault.getAbstractFileByPath(entry.filePath);
      if (!(file instanceof TFile)) return;

      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return;

      if (entry.mode === "edit") {
        const editor = view.editor;
        editor.setSelection(
          { line: entry.selection.startLine, ch: entry.selection.startCol },
          { line: entry.selection.endLine, ch: entry.selection.endCol },
        );
        editor.scrollIntoView(
          {
            from: { line: entry.selection.startLine, ch: entry.selection.startCol },
            to: { line: entry.selection.endLine, ch: entry.selection.endCol },
          },
          true,
        );
      } else if (entry.mode === "preview") {
        // Wait for Reading View DOM rendering to complete before applying scroll position
        this.applyPreviewScrollWithRetry(view, entry.selection);
      }

      this.currentState = entry;
    } finally {
      setTimeout(() => {
        this.isNavigating = false;
      }, 150);
    }
  }

  private applyPreviewScrollWithRetry(view: MarkdownView, selection: PreviewSelection, attempts = 0): void {
    const previewEl = view.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null;
    const previewView = view.previewMode;

    if (previewEl && previewEl.scrollHeight > 0) {
      if (typeof previewView.applyScroll === "function") {
        previewView.applyScroll(selection.scrollLine);
      }
      previewEl.scrollTop = selection.scrollTop;
    } else if (attempts < 10) {
      setTimeout(() => {
        this.applyPreviewScrollWithRetry(view, selection, attempts + 1);
      }, 30);
    }
  }
}
