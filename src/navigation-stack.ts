export interface EditSelection {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface PreviewSelection {
  scrollTop: number;
  scrollLine: number;
}

export interface EditHistoryEntry {
  mode: "edit";
  filePath: string;
  selection: EditSelection;
  timestamp: number;
}

export interface PreviewHistoryEntry {
  mode: "preview";
  filePath: string;
  selection: PreviewSelection;
  timestamp: number;
}

export type HistoryEntry = EditHistoryEntry | PreviewHistoryEntry;

export interface FileCursorPosition<T = EditSelection | PreviewSelection> {
  selection: T;
  timestamp: number;
}

export interface FileLastPositions {
  edit?: FileCursorPosition<EditSelection>;
  preview?: FileCursorPosition<PreviewSelection>;
}

export type FileHistoryMap = Record<string, FileLastPositions>;

export class NavigationStack {
  private editStack: EditHistoryEntry[] = [];
  private editIndex = -1;

  private previewStack: PreviewHistoryEntry[] = [];
  private previewIndex = -1;

  truncate(n: number): void {
    if (n <= 0) {
      this.editStack = [];
      this.editIndex = -1;
      this.previewStack = [];
      this.previewIndex = -1;
      return;
    }
    while (this.editStack.length > n) {
      this.editStack.shift();
    }
    this.editIndex = Math.min(this.editIndex, this.editStack.length - 1);

    while (this.previewStack.length > n) {
      this.previewStack.shift();
    }
    this.previewIndex = Math.min(
      this.previewIndex,
      this.previewStack.length - 1,
    );
  }

  push(entry: HistoryEntry): void {
    if (entry.mode === "edit") {
      this.pushEdit(entry);
    } else {
      this.pushPreview(entry);
    }
  }

  private pushEdit(entry: EditHistoryEntry): void {
    if (this.editIndex >= 0 && this.editIndex < this.editStack.length) {
      const current = this.editStack[this.editIndex];
      if (
        current.filePath === entry.filePath
        && current.selection.startLine === entry.selection.startLine
      ) {
        this.editStack[this.editIndex] = entry;
        return;
      }
    }

    if (this.editIndex < this.editStack.length - 1) {
      this.editStack = this.editStack.slice(0, this.editIndex + 1);
    }

    this.editStack.push(entry);
    this.editIndex = this.editStack.length - 1;
  }

  private pushPreview(entry: PreviewHistoryEntry): void {
    if (this.previewIndex < this.previewStack.length - 1) {
      this.previewStack = this.previewStack.slice(0, this.previewIndex + 1);
    }

    this.previewStack.push(entry);
    this.previewIndex = this.previewStack.length - 1;
  }

  replaceCurrent(entry: HistoryEntry): void {
    if (entry.mode === "edit") {
      if (this.editIndex >= 0 && this.editIndex < this.editStack.length) {
        this.editStack[this.editIndex] = entry;
      } else {
        this.pushEdit(entry);
      }
    } else {
      if (
        this.previewIndex >= 0
        && this.previewIndex < this.previewStack.length
      ) {
        this.previewStack[this.previewIndex] = entry;
      } else {
        this.pushPreview(entry);
      }
    }
  }

  goBack(mode: "edit" | "preview"): HistoryEntry | null {
    if (mode === "edit") {
      if (this.editIndex <= 0) return null;
      this.editIndex--;
      return this.editStack[this.editIndex];
    } else {
      if (this.previewIndex <= 0) return null;
      this.previewIndex--;
      return this.previewStack[this.previewIndex];
    }
  }

  goForward(mode: "edit" | "preview"): HistoryEntry | null {
    if (mode === "edit") {
      if (this.editIndex >= this.editStack.length - 1) return null;
      this.editIndex++;
      return this.editStack[this.editIndex];
    } else {
      if (this.previewIndex >= this.previewStack.length - 1) return null;
      this.previewIndex++;
      return this.previewStack[this.previewIndex];
    }
  }

  getCurrent(mode: "edit" | "preview"): HistoryEntry | null {
    if (mode === "edit") {
      if (this.editIndex >= 0 && this.editIndex < this.editStack.length) {
        return this.editStack[this.editIndex];
      }
    } else {
      if (
        this.previewIndex >= 0
        && this.previewIndex < this.previewStack.length
      ) {
        return this.previewStack[this.previewIndex];
      }
    }
    return null;
  }

  findLatestForFile(
    filePath: string,
    mode?: "edit" | "preview",
  ): HistoryEntry | null {
    if (mode === "edit") {
      for (let i = this.editStack.length - 1; i >= 0; i--) {
        if (this.editStack[i].filePath === filePath) return this.editStack[i];
      }
      return null;
    } else if (mode === "preview") {
      for (let i = this.previewStack.length - 1; i >= 0; i--) {
        if (this.previewStack[i].filePath === filePath) {
          return this.previewStack[i];
        }
      }
      return null;
    }

    // Mode omitted: check both stacks for latest
    const lastEdit = this.editStack
      .slice()
      .reverse()
      .find((e) => e.filePath === filePath);
    const lastPreview = this.previewStack
      .slice()
      .reverse()
      .find((e) => e.filePath === filePath);

    if (!lastEdit) return lastPreview || null;
    if (!lastPreview) return lastEdit;

    return (lastEdit.timestamp || 0) >= (lastPreview.timestamp || 0)
      ? lastEdit
      : lastPreview;
  }

  getStack(mode?: "edit" | "preview"): HistoryEntry[] {
    if (mode === "edit") return [...this.editStack];
    if (mode === "preview") return [...this.previewStack];
    return [...this.editStack, ...this.previewStack];
  }

  getStackForFile(filePath: string, mode?: "edit" | "preview"): HistoryEntry[] {
    return this.getStack(mode).filter((e) => e.filePath === filePath);
  }

  setStack(entries: HistoryEntry[]): void {
    const list = Array.isArray(entries) ? entries : [];
    this.editStack = list.filter(
      (e): e is EditHistoryEntry => e.mode === "edit",
    );
    this.editIndex = this.editStack.length - 1;

    this.previewStack = list.filter(
      (e): e is PreviewHistoryEntry => e.mode === "preview",
    );
    this.previewIndex = this.previewStack.length - 1;
  }

  purgeInvalid(isValidFn: (filePath: string) => boolean): void {
    const currEdit = this.getCurrent("edit");
    this.editStack = this.editStack.filter((e) => isValidFn(e.filePath));
    if (currEdit && isValidFn(currEdit.filePath)) {
      this.editIndex = this.editStack.indexOf(currEdit as EditHistoryEntry);
      if (this.editIndex === -1) this.editIndex = this.editStack.length - 1;
    } else {
      this.editIndex = this.editStack.length - 1;
    }

    const currPreview = this.getCurrent("preview");
    this.previewStack = this.previewStack.filter((e) => isValidFn(e.filePath));
    if (currPreview && isValidFn(currPreview.filePath)) {
      this.previewIndex = this.previewStack.indexOf(
        currPreview as PreviewHistoryEntry,
      );
      if (this.previewIndex === -1) {
        this.previewIndex = this.previewStack.length - 1;
      }
    } else {
      this.previewIndex = this.previewStack.length - 1;
    }
  }

  clearForFile(filePath: string, mode?: "edit" | "preview"): void {
    if (!mode || mode === "edit") {
      this.editStack = this.editStack.filter((e) => e.filePath !== filePath);
      this.editIndex = this.editStack.length - 1;
    }
    if (!mode || mode === "preview") {
      this.previewStack = this.previewStack.filter(
        (e) => e.filePath !== filePath,
      );
      this.previewIndex = this.previewStack.length - 1;
    }
  }

  /**
   * Remove entries before the current position that are considered similar to the current entry,
   * compressing the stack so that goBack jumps further back.
   */
  compressSimilarBeforeCurrent(
    mode: "edit" | "preview",
    isSimilar: (a: HistoryEntry, b: HistoryEntry) => boolean,
  ): void {
    if (mode === "edit") {
      let idx = this.editIndex;
      while (
        idx > 0
        && isSimilar(this.editStack[idx], this.editStack[idx - 1])
      ) {
        this.editStack.splice(idx - 1, 1);
        idx--;
      }
      this.editIndex = idx;
    } else {
      let idx = this.previewIndex;
      while (
        idx > 0
        && isSimilar(this.previewStack[idx], this.previewStack[idx - 1])
      ) {
        this.previewStack.splice(idx - 1, 1);
        idx--;
      }
      this.previewIndex = idx;
    }
  }

  /**
   * Remove entries after the current position that are considered similar to the current entry,
   * compressing the stack so that goForward jumps further forward.
   */
  compressSimilarAfterCurrent(
    mode: "edit" | "preview",
    isSimilar: (a: HistoryEntry, b: HistoryEntry) => boolean,
  ): void {
    if (mode === "edit") {
      const idx = this.editIndex;
      while (
        idx < this.editStack.length - 1
        && isSimilar(this.editStack[idx], this.editStack[idx + 1])
      ) {
        this.editStack.splice(idx + 1, 1);
      }
    } else {
      const idx = this.previewIndex;
      while (
        idx < this.previewStack.length - 1
        && isSimilar(this.previewStack[idx], this.previewStack[idx + 1])
      ) {
        this.previewStack.splice(idx + 1, 1);
      }
    }
  }
}
