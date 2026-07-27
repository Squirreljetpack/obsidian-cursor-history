import { Extension } from "@codemirror/state";
import { EditorView, keymap, ViewUpdate } from "@codemirror/view";
import { MarkdownView, Notice, normalizePath, PaneType, Plugin, SplitDirection, TFile, WorkspaceLeaf } from "obsidian";
import { CodeFoldManager } from "./code-fold-manager";
import { CurrentFileHistoryModal } from "./current-file-history-modal";
import { HistoryNavigatorModal } from "./history-navigator-modal";
import { RecentFileItem, RecentFilesModal } from "./recent-files-modal";
import { TruncateHistoryModal } from "./truncate-history-modal";
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


export default class CursorHistoryPlugin extends Plugin {
  settings: CursorHistorySettings = DEFAULT_SETTINGS;
  private navStack = new NavigationStack(50);
  private fileLastPositions = new Map<string, FileLastPositions>();
  private currentState: HistoryEntry | null = null;
  private isNavigating = false;
  private openingFiles = new Set<string>();
  private openingFileTimers = new Map<string, number>();
  private openingRestorations = new Map<string, Promise<void>>();
  private leafFileMap = new WeakMap<WorkspaceLeaf, string>();
  private hotkeyExtension: Extension[] = [];
  private saveTimeoutId: number | null = null;
  private lastActiveLeaf: WorkspaceLeaf | null = null;
  public codeFoldManager = new CodeFoldManager(this);

  private ensureLeafLockedIfFileChanged(leaf: WorkspaceLeaf | null | undefined): void {
    if (!leaf) return;
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file) {
      const lastPath = this.leafFileMap.get(leaf);
      if (lastPath !== view.file.path) {
        this.leafFileMap.set(leaf, view.file.path);
        this.lockOpeningFile(view.file.path);
      }
    }
  }

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
        if (this.settings.initialModal === "global") {
          new HistoryNavigatorModal(this.app, this).open();
        } else {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view || !view.file) {
            new HistoryNavigatorModal(this.app, this).open();
          } else {
            new CurrentFileHistoryModal(this.app, this).open();
          }
        }
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
      id: "truncate-cursor-history",
      name: "Truncate cursor history",
      callback: () => {
        new TruncateHistoryModal(this.app, this).open();
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

        this.ensureLeafLockedIfFileChanged(leaf);

        if (this.lastActiveLeaf && this.lastActiveLeaf !== leaf) {
          this.recordPositionForLeaf(this.lastActiveLeaf, false);
        }
        this.lastActiveLeaf = leaf;
      }),
    );

    // Listen for file opening in normal way to restore position or record target position
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || this.isNavigating) return;
        this.lockOpeningFile(file.path);
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView && activeView.file?.path === file.path && activeView.leaf) {
          this.leafFileMap.set(activeView.leaf, file.path);
        }
        const openPromise = this.handleDocumentOpen(file);
        this.openingRestorations.set(file.path, openPromise);
      }),
    );

    // Listen for cursor changes within CM6 editors (Edit Mode)
    this.registerEditorExtension(
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (this.isNavigating) return;

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) return;

        this.ensureLeafLockedIfFileChanged(activeView.leaf);
        if (this.openingFiles.has(activeView.file.path)) return;

        if (activeView.getMode() !== "source") return;

        if (update.docChanged) {
          this.lockOpeningFile(activeView.file.path);
          return;
        }

        if (!update.selectionSet) return;

        this.recordCurrentPosition();
      }),
    );

    // Keymaps for key-repeat support
    this.registerEditorExtension(this.hotkeyExtension);
    this.app.workspace.onLayoutReady(() => {
      this.buildKeymap();
      void this.removeNonExistentFileHistories();
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

  getCurrentState(): HistoryEntry | null {
    return this.currentState;
  }

  public getRecentlyOpenedFiles(): RecentFileItem[] {
    const timestamps = new Map<string, number>();

    for (const [filePath, pos] of this.fileLastPositions.entries()) {
      const editTs = pos.edit?.timestamp ?? 0;
      const previewTs = pos.preview?.timestamp ?? 0;
      const maxTs = Math.max(editTs, previewTs);
      if (maxTs > 0) {
        timestamps.set(filePath, maxTs);
      }
    }

    const stack = this.navStack.getStack();
    for (const entry of stack) {
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
      const file = this.getFileByPath(path);
      if (file) {
        const timestamp = timestamps.get(path) ?? file.stat.mtime;
        result.push({ file, timestamp });
      }
    }

    return result;
  }

  public async openRecentFile(
    file: TFile,
    newLeaf?: PaneType | boolean,
    direction?: SplitDirection,
  ): Promise<void> {
    const navEntry = this.navStack.findLatestForFile(file.path);
    if (navEntry) {
      await this.navigateTo(navEntry, newLeaf, direction);
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
        await this.navigateTo(entry, newLeaf, direction);
        return;
      }
    }

    let leaf: WorkspaceLeaf;
    if (newLeaf) {
      if (newLeaf === "split" && direction) {
        leaf = this.app.workspace.getLeaf("split", direction);
      } else {
        leaf = this.app.workspace.getLeaf(newLeaf);
      }
    } else {
      leaf = this.app.workspace.getLeaf(false);
    }
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

  private getFileByPath(filePath: string): TFile | null {
    if (!filePath || typeof filePath !== "string") return null;
    if (filePath.startsWith("!") || filePath.includes("![[")) return null;
    if (filePath.includes("..") || filePath.includes("\0")) return null;

    const normalized = normalizePath(filePath);
    const abstractFile = this.app.vault.getAbstractFileByPath(normalized);
    if (abstractFile instanceof TFile && abstractFile.extension === "md") {
      return abstractFile;
    }

    const linkFile = this.app.metadataCache.getFirstLinkpathDest(filePath, "");
    if (linkFile instanceof TFile && linkFile.extension === "md") {
      return linkFile;
    }

    return null;
  }

  private isValidFilePath(filePath: string): boolean {
    return this.getFileByPath(filePath) !== null;
  }

  private cleanupInvalidDbEntries(): void {
    this.navStack.purgeInvalid(this.isValidFilePath.bind(this));
    for (const filePath of Array.from(this.fileLastPositions.keys())) {
      if (!this.isValidFilePath(filePath)) {
        this.fileLastPositions.delete(filePath);
      }
    }
  }

  public async removeNonExistentFileHistories(): Promise<void> {
    const initialPosCount = this.fileLastPositions.size;
    const initialStackCount = this.navStack.getStack().length;

    this.cleanupInvalidDbEntries();

    if (
      this.fileLastPositions.size !== initialPosCount ||
      this.navStack.getStack().length !== initialStackCount
    ) {
      await this.saveHistoryStackImmediate();
    }
  }

  public async clearCurrentFileHistory(): Promise<boolean> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice("No active file to clear history.");
      return false;
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
    return true;
  }

  public async clearGlobalHistory(): Promise<void> {
    this.navStack.truncate(0);
    this.fileLastPositions.clear();
    this.currentState = null;
    await this.codeFoldManager.clearAllFoldHistory();
    await this.saveHistoryStackImmediate();
    new Notice("Cleared global cursor and code fold history.");
  }

  public async truncateHistory(n: number): Promise<void> {
    this.navStack.truncate(n);

    if (n <= 0) {
      this.fileLastPositions.clear();
      this.currentState = null;
    } else {
      const entries = Array.from(this.fileLastPositions.entries()).map(([path, pos]) => {
        const editTs = pos.edit?.timestamp ?? 0;
        const previewTs = pos.preview?.timestamp ?? 0;
        return { path, maxTs: Math.max(editTs, previewTs) };
      });

      entries.sort((a, b) => b.maxTs - a.maxTs);

      if (entries.length > n) {
        const toKeep = new Set(entries.slice(0, n).map((e) => e.path));
        for (const path of Array.from(this.fileLastPositions.keys())) {
          if (!toKeep.has(path)) {
            this.fileLastPositions.delete(path);
          }
        }
      }
    }

    await this.saveHistoryStackImmediate();
    new Notice(`Truncated cursor history to ${n} entries.`);
  }

  private getMarkdownViewForFile(filePath: string): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path === filePath) {
      return activeView;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    const matchingLeaf = leaves.find((l) => (l.view as MarkdownView).file?.path === filePath);
    if (matchingLeaf) {
      return matchingLeaf.view as MarkdownView;
    }
    return null;
  }

  private lockOpeningFile(filePath: string): void {
    if (!filePath) return;
    this.openingFiles.add(filePath);

    const delay = this.settings.openRecordDelayMs ?? 1000;

    const existingTimer = this.openingFileTimers.get(filePath);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    const timer = window.setTimeout(async () => {
      const restorationPromise = this.openingRestorations.get(filePath);
      if (restorationPromise) {
        try {
          await restorationPromise;
        } catch {
          // ignore error in scroll restoration
        }
      }

      if (this.openingFileTimers.get(filePath) !== timer) return;

      this.openingFiles.delete(filePath);
      this.openingFileTimers.delete(filePath);
      this.openingRestorations.delete(filePath);

      const settledView = this.getMarkdownViewForFile(filePath);
      if (settledView && settledView.file?.path === filePath) {
        this.recordPositionForView(settledView, true);
      }
    }, delay);

    this.openingFileTimers.set(filePath, timer);
  }

  private async handleDocumentOpen(file: TFile): Promise<void> {
    const filePath = file.path;

    await new Promise((resolve) => setTimeout(resolve, 50));

    const view = this.getMarkdownViewForFile(filePath);
    if (!view || view.file?.path !== filePath) return;

    const hasTarget = this.hasOpenFileTargetLine(view);

    if (!hasTarget) {
      // Non-targeted open:
      // DO scroll (restore stored position if restoreScrollPosition setting is enabled)
      if (this.settings.restoreScrollPosition) {
        await this.restorePositionForOpenFile(filePath);
      }
    }
  }

  private hasOpenFileTargetLine(view: MarkdownView): boolean {
    const leaf = view.leaf as any;
    if (!leaf) return false;

    // 1. Check Ephemeral State (eState)
    const eState = typeof leaf.getEphemeralState === "function" ? leaf.getEphemeralState() : null;
    if (eState) {
      if (typeof eState.line === "number" && eState.line > 0) {
        return true;
      }
      if (eState.cursor && (eState.cursor.line > 0 || eState.cursor.from?.line > 0)) {
        return true;
      }
      if (typeof eState.subpath === "string" && eState.subpath.trim() !== "") {
        return true;
      }
      if (eState.match) {
        return true;
      }
      if (typeof eState.scroll === "number" && eState.scroll > 0) {
        return true;
      }
    }

    // 2. Check View State (state.subpath)
    const viewState = typeof leaf.getViewState === "function" ? leaf.getViewState() : null;
    if (viewState?.state) {
      if (typeof viewState.state.subpath === "string" && viewState.state.subpath.trim() !== "") {
        return true;
      }
    }

    return false;
  }

  private async restorePositionForOpenFile(filePath: string): Promise<void> {
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== filePath) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const matchingLeaf = leaves.find((l) => (l.view as MarkdownView).file?.path === filePath);
      if (matchingLeaf) {
        view = matchingLeaf.view as MarkdownView;
      }
    }

    if (!view || view.file?.path !== filePath) return;

    const dbRecord = this.fileLastPositions.get(filePath);
    if (!dbRecord) return;

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
      await this.navigateTo(entry);
    } else if (targetMode === "preview" && dbRecord.preview) {
      const entry: HistoryEntry = {
        mode: "preview",
        filePath,
        selection: dbRecord.preview.selection,
        timestamp: dbRecord.preview.timestamp,
      };
      await this.navigateTo(entry);
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

    this.ensureLeafLockedIfFileChanged(view.leaf);
    if (this.openingFiles.has(view.file.path)) return;

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

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) return;

    this.ensureLeafLockedIfFileChanged(view.leaf);
    if (this.openingFiles.has(view.file.path)) return;

    if (this.previewScrollTimeoutId !== null) {
      window.clearTimeout(this.previewScrollTimeoutId);
    }

    this.previewScrollTimeoutId = window.setTimeout(() => {
      this.previewScrollTimeoutId = null;
      if (view.file && !this.openingFiles.has(view.file.path)) {
        this.recordCurrentPosition();
      }
    }, this.settings.scrollDebounceMs ?? 100);
  }

  private recordCurrentPosition(saveToDisk = true): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;
    this.recordPositionForView(view, saveToDisk);
  }

  private recordPositionForLeaf(leaf: WorkspaceLeaf, saveToDisk = true): void {
    if (leaf.view instanceof MarkdownView && leaf.view.file) {
      this.recordPositionForView(leaf.view, saveToDisk);
    }
  }

  private recordPositionForView(view: MarkdownView, saveToDisk = true): void {
    if (!view?.file) return;

    this.ensureLeafLockedIfFileChanged(view.leaf);
    if (this.openingFiles.has(view.file.path)) return;

    const entry = this.getEntryForView(view);
    if (!entry || entry.filePath !== view.file.path) return;

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

    this.currentState = entry;

    if (saveToDisk) {
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

      this.scheduleHistorySave();
    }
  }

  private getEntryForView(view: MarkdownView): HistoryEntry | null {
    if (!view?.file) return null;
    const mode = view.getMode();

    if (mode === "preview") {
      const previewView = view.previewMode;
      let scrollLine = typeof previewView.getScroll === "function" ? previewView.getScroll() : 0;
      const previewEl = view.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null;
      const scrollTop = previewEl ? previewEl.scrollTop : 0;

      if (scrollLine === 0 && previewEl && previewEl.scrollTop > 10) {
        const sections = previewEl.querySelectorAll(".markdown-rendered > *");
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i] as HTMLElement;
          if (sec.offsetTop + sec.offsetHeight > previewEl.scrollTop) {
            const line = this.getClickedLineFromElement(sec);
            if (line !== null && line >= 0) {
              scrollLine = line;
              break;
            }
          }
        }
        if (scrollLine === 0) {
          scrollLine = Math.floor(previewEl.scrollTop / 24);
        }
      }

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

  public async navigateTo(
    entry: HistoryEntry,
    newLeaf?: PaneType | boolean,
    direction?: SplitDirection,
  ): Promise<void> {
    this.isNavigating = true;

    try {
      const file = this.getFileByPath(entry.filePath);
      if (!file) return;

      let view: MarkdownView | null = null;

      if (newLeaf) {
        let leaf: WorkspaceLeaf;
        if (newLeaf === "split" && direction) {
          leaf = this.app.workspace.getLeaf("split", direction);
        } else {
          leaf = this.app.workspace.getLeaf(newLeaf);
        }
        await leaf.openFile(file);
        if (leaf.view instanceof MarkdownView) {
          view = leaf.view;
        } else {
          view = this.app.workspace.getActiveViewOfType(MarkdownView);
        }
      } else {
        view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view || view.file?.path !== entry.filePath) {
          const leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(file);
          view = this.app.workspace.getActiveViewOfType(MarkdownView);
        }
      }

      if (!view || view.file?.path !== entry.filePath) return;

      if (entry.mode === "edit") {
        if (view.getMode() !== "source") {
          await view.setState({ mode: "source" }, { history: false });
        }
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
        if (view.getMode() !== "preview") {
          await view.setState({ mode: "preview" }, { history: false });
        }
        await this.applyPreviewScrollWithRetry(view, entry.selection);
      }

      this.currentState = entry;
    } finally {
      setTimeout(() => {
        this.isNavigating = false;
      }, 200);
    }
  }

  private applyPreviewScrollWithRetry(view: MarkdownView, selection: PreviewSelection, attempts = 0): Promise<void> {
    return new Promise((resolve) => {
      const doScroll = (currAttempt: number) => {
        const previewEl = view.contentEl.querySelector(".markdown-preview-view") as HTMLElement | null;
        const previewView = view.previewMode;

        if (previewEl) {
          if (typeof previewView.applyScroll === "function") {
            previewView.applyScroll(selection.scrollLine);
          }
          if (selection.scrollTop > 0) {
            previewEl.scrollTop = selection.scrollTop;
          }

          const isTargetReached = selection.scrollTop === 0 || Math.abs(previewEl.scrollTop - selection.scrollTop) <= 2;
          const isAtBottom =
            previewEl.scrollTop > 0 &&
            Math.abs(previewEl.scrollTop - (previewEl.scrollHeight - previewEl.clientHeight)) <= 2;

          if ((isTargetReached || isAtBottom) && currAttempt >= 2) {
            resolve();
            return;
          }
        }

        if (currAttempt < 25) {
          setTimeout(() => {
            doScroll(currAttempt + 1);
          }, 40);
        } else {
          resolve();
        }
      };
      doScroll(attempts);
    });
  }
}
