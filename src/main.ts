import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  MarkdownView,
  normalizePath,
  Notice,
  type PaneType,
  Plugin,
  type SplitDirection,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { CodeFoldManager } from "./code-fold-manager.js";
import { CurrentFileHistoryModal } from "./current-file-history-modal.js";
import { HistoryNavigatorModal } from "./history-navigator-modal.js";
import {
  type EditHistoryEntry,
  type EditSelection,
  type FileHistoryMap,
  type FileLastPositions,
  type HistoryEntry,
  NavigationStack,
  type PreviewHistoryEntry,
  type PreviewSelection,
} from "./navigation-stack.js";
import { type RecentFileItem, RecentFilesModal } from "./recent-files-modal.js";
import { shouldCreateNewEntry } from "./selection-state.js";
import { type CursorHistorySettings, CursorHistorySettingTab, DEFAULT_SETTINGS } from "./settings.js";
import { TruncateHistoryModal } from "./truncate-history-modal.js";

// --- Obsidian type augmentation for undocumented APIs ---

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
  private saveTimeoutId: number | null = null;
  private lastActiveLeaf: WorkspaceLeaf | null = null;
  public codeFoldManager = new CodeFoldManager(this);

  private ensureLeafLockedIfFileChanged(
    leaf: WorkspaceLeaf | null | undefined,
  ): void {
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
        this.compressHistoryStacksBeforeModal();
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

    // Capturing phase DOM click listener for Reading View clicks (including internal links)
    this.registerDomEvent(
      document,
      "click",
      (evt: MouseEvent) => {
        if (this.isNavigating) return;

        const target = evt.target as HTMLElement | null;
        if (!target || !target.closest(".markdown-preview-view")) return;
        if (target.closest("button, input, textarea, select")) return;

        const view = this.getMarkdownViewFromTarget(target);
        if (!view || view.getMode() !== "preview" || !view.file) return;

        this.ensureLeafLockedIfFileChanged(view.leaf);
        if (this.openingFiles.has(view.file.path)) return;

        this.handleReadingViewClick(target, view);
      },
      true, // useCapture phase
    );

    // Capturing phase DOM scroll listener for Reading View scrolling
    this.registerDomEvent(
      document,
      "scroll",
      (evt: Event) => {
        const target = evt.target as HTMLElement | null;
        if (
          target
          && target.classList
          && target.classList.contains("markdown-preview-view")
        ) {
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
        if (
          activeView
          && activeView.file?.path === file.path
          && activeView.leaf
        ) {
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

    this.app.workspace.onLayoutReady(() => {
      void this.removeNonExistentFileHistories();
    });
  }

  async onunload() {
    await this.saveHistoryImmediate();
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, rawData);
    this.navStack.setMaxSize(this.settings.maxEntries);
    await this.loadHistory();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      this.fileLastPositions.size !== initialPosCount
      || this.navStack.getStack().length !== initialStackCount
    ) {
      await this.saveHistoryImmediate();
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
      if (
        this.currentState
        && this.currentState.filePath === filePath
        && this.currentState.mode === "edit"
      ) {
        this.currentState = null;
      }
      await this.saveHistoryImmediate();
      new Notice(`Cleared edit cursor history for ${view.file.basename}`);
    } else {
      await this.codeFoldManager.clearFileFoldHistory(filePath);
      this.navStack.clearForFile(filePath, "preview");
      const pos = this.fileLastPositions.get(filePath);
      if (pos) {
        delete pos.preview;
        if (!pos.edit && !pos.preview) this.fileLastPositions.delete(filePath);
      }
      if (
        this.currentState
        && this.currentState.filePath === filePath
        && this.currentState.mode === "preview"
      ) {
        this.currentState = null;
      }
      await this.saveHistoryImmediate();
      new Notice(
        `Cleared code fold and preview history for ${view.file.basename}`,
      );
    }
    return true;
  }

  public async clearGlobalHistory(): Promise<void> {
    this.navStack.truncate(0);
    this.fileLastPositions.clear();
    this.currentState = null;
    await this.codeFoldManager.clearAllFoldHistory();
    await this.saveHistoryImmediate();
    new Notice("Cleared global cursor and code fold history.");
  }

  public async truncateHistory(n: number): Promise<void> {
    this.navStack.truncate(n);

    if (n <= 0) {
      this.fileLastPositions.clear();
      this.currentState = null;
    } else {
      const entries = Array.from(this.fileLastPositions.entries()).map(
        ([path, pos]) => {
          const editTs = pos.edit?.timestamp ?? 0;
          const previewTs = pos.preview?.timestamp ?? 0;
          return { path, maxTs: Math.max(editTs, previewTs) };
        },
      );

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

    await this.saveHistoryImmediate();
    new Notice(`Truncated cursor history to ${n} entries.`);
  }

  private getMarkdownViewForFile(filePath: string): MarkdownView | null {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file?.path === filePath) {
      return activeView;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    const matchingLeaf = leaves.find(
      (l) => (l.view as MarkdownView).file?.path === filePath,
    );
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
    const leaf = view.leaf;
    if (!leaf) return false;

    // 1. Check Ephemeral State (eState)
    const eState = leaf.getEphemeralState();
    if (eState) {
      if (typeof eState.line === "number" && eState.line > 0) {
        return true;
      }
      if (
        eState.cursor
        && (eState.cursor.line > 0 || eState.cursor.from?.line > 0)
      ) {
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
    const viewState = leaf.getViewState();
    if (
      typeof viewState?.state?.subpath === "string"
      && viewState.state.subpath.trim() !== ""
    ) {
      return true;
    }

    return false;
  }

  private async restorePositionForOpenFile(filePath: string): Promise<void> {
    let view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== filePath) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      const matchingLeaf = leaves.find(
        (l) => (l.view as MarkdownView).file?.path === filePath,
      );
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

  private async loadHistory(): Promise<void> {
    this.fileLastPositions.clear();
    let rawContent: FileHistoryMap | null = null;

    if (this.settings.useFolderLocalHistory) {
      const path = this.getHistoryFilePath();
      try {
        if (await this.app.vault.adapter.exists(path)) {
          const content = await this.app.vault.adapter.read(path);
          rawContent = JSON.parse(content);
        }
      } catch (err) {
        console.error(
          "Cursor History: Error reading folder local history file:",
          err,
        );
      }
    } else {
      const rawData = (await this.loadData()) || {};
      rawContent = rawData.historyStack;
    }

    if (
      rawContent
      && typeof rawContent === "object"
      && !Array.isArray(rawContent)
    ) {
      for (const [filePath, pos] of Object.entries(rawContent)) {
        if (pos && typeof pos === "object") {
          this.fileLastPositions.set(filePath, pos);
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
    const delayMs = (this.settings.historySaveDelaySec ?? 10) * 1000;
    this.saveTimeoutId = window.setTimeout(() => {
      this.saveTimeoutId = null;
      void this.saveHistoryImmediate();
    }, delayMs);
  }

  private async saveHistoryImmediate(): Promise<void> {
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
        await this.app.vault.adapter.write(
          path,
          JSON.stringify(fileMap, null, 2),
        );
      } catch (err) {
        console.error(
          "Cursor History: Error writing folder local history file:",
          err,
        );
      }
    } else {
      const rawData = (await this.loadData()) || {};
      rawData.historyStack = fileMap;
      await this.saveData(rawData);
    }
  }

  private previewScrollTimeoutId: number | null = null;

  private getMarkdownViewFromTarget(target: HTMLElement): MarkdownView | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      if (
        leaf.view instanceof MarkdownView
        && leaf.view.containerEl.contains(target)
      ) {
        return leaf.view;
      }
    }
    return null;
  }

  private getClickedLineFromElement(
    target: HTMLElement | null,
    view: MarkdownView,
  ): number | null {
    if (!target || !view || !view.previewMode) return null;

    const renderer = (view.previewMode as any).renderer;
    const sections = renderer?.sections;
    if (Array.isArray(sections)) {
      for (const section of sections) {
        if (section && section.el && section.el.contains(target)) {
          if (section.start && typeof section.start.line === "number") {
            return section.start.line;
          }
          if (typeof section.lineStart === "number") {
            return section.lineStart;
          }
          if (typeof section.line === "number") {
            return section.line;
          }
        }
      }
    }

    return null;
  }

  private handleReadingViewClick(
    target: HTMLElement,
    view: MarkdownView,
  ): void {
    if (!view.file) return;

    const clickedLine = this.getClickedLineFromElement(target, view);
    if (clickedLine === null) {
      this.recordPositionForView(view);
      return;
    }

    const previewEl = view.contentEl.querySelector(
      ".markdown-preview-view",
    ) as HTMLElement | null;
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
    filePos.preview = {
      selection: entry.selection,
      timestamp: entry.timestamp,
    };

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
      let scrollLine = previewView.getScroll();
      const previewEl = view.contentEl.querySelector(
        ".markdown-preview-view",
      ) as HTMLElement | null;
      const scrollTop = previewEl ? previewEl.scrollTop : 0;

      if (scrollLine === 0 && previewEl && previewEl.scrollTop > 10) {
        const sections = previewEl.querySelectorAll(".markdown-rendered > *");
        for (let i = 0; i < sections.length; i++) {
          const sec = sections[i] as HTMLElement;
          if (sec.offsetTop + sec.offsetHeight > previewEl.scrollTop) {
            const line = this.getClickedLineFromElement(sec, view);
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

  private isSimilarEntry(a: HistoryEntry, b: HistoryEntry): boolean {
    const { mergeSimilarEntriesOnJump } = this.settings;

    if (mergeSimilarEntriesOnJump === "off") {
      return false;
    }

    // "strict": exact match (scrollLine or full selection equality)
    if (a.mode === "edit" && b.mode === "edit") {
      const ae = a.selection as EditSelection;
      const be = b.selection as EditSelection;
      return (
        ae.startLine === be.startLine
        && ae.startCol === be.startCol
        && ae.endLine === be.endLine
        && ae.endCol === be.endCol
      );
    }

    if (a.mode === "preview" && b.mode === "preview") {
      const ap = a.selection as PreviewSelection;
      const bp = b.selection as PreviewSelection;
      if (ap.scrollLine === bp.scrollLine) return true;
      // if (Math.abs(ap.scrollTop - bp.scrollTop) < 10) return true;
      return false;
    }

    // "half" or "threshold": use shouldCreateNewEntry logic (returns false when entries are similar)
    if (
      mergeSimilarEntriesOnJump === "half"
      || mergeSimilarEntriesOnJump === "threshold"
    ) {
      const { editJumpThreshold, previewJumpThreshold } = this.settings;
      const editTh = mergeSimilarEntriesOnJump === "half"
        ? Math.floor(editJumpThreshold / 2)
        : editJumpThreshold;
      const previewTh = mergeSimilarEntriesOnJump === "half"
        ? Math.floor(previewJumpThreshold / 2)
        : previewJumpThreshold;
      return !shouldCreateNewEntry(a, b, editTh, previewTh);
    }

    return false;
  }

  private async goBack(): Promise<void> {
    const mode = this.getCurrentMode();
    this.navStack.compressSimilarBeforeCurrent(mode, (a, b) => this.isSimilarEntry(a, b));
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

    const entry = this.navStack.goBack(mode);
    if (entry) await this.navigateTo(entry);
  }

  private async goForward(): Promise<void> {
    const mode = this.getCurrentMode();
    this.navStack.compressSimilarAfterCurrent(mode, (a, b) => this.isSimilarEntry(a, b));
    const entry = this.navStack.goForward(mode);
    if (entry) await this.navigateTo(entry);
  }

  private compressHistoryStacksBeforeModal(): void {
    const mode = this.getCurrentMode();
    const isSimilar = (a: HistoryEntry, b: HistoryEntry) => this.isSimilarEntry(a, b);
    this.navStack.compressSimilarBeforeCurrent(mode, isSimilar);
    this.navStack.compressSimilarAfterCurrent(mode, isSimilar);
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
            from: {
              line: entry.selection.startLine,
              ch: entry.selection.startCol,
            },
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

  private applyPreviewScrollWithRetry(
    view: MarkdownView,
    selection: PreviewSelection,
    attempts = 0,
  ): Promise<void> {
    return new Promise((resolve) => {
      const doScroll = (currAttempt: number) => {
        const previewEl = view.contentEl.querySelector(
          ".markdown-preview-view",
        ) as HTMLElement | null;
        const previewView = view.previewMode;

        if (previewEl) {
          if (typeof previewView.applyScroll === "function") {
            previewView.applyScroll(selection.scrollLine);
          }
          if (selection.scrollTop > 0) {
            previewEl.scrollTop = selection.scrollTop;
          }

          const isTargetReached = selection.scrollTop === 0
            || Math.abs(previewEl.scrollTop - selection.scrollTop) <= 2;
          const isAtBottom = previewEl.scrollTop > 0
            && Math.abs(
                previewEl.scrollTop
                  - (previewEl.scrollHeight - previewEl.clientHeight),
              ) <= 2;

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
