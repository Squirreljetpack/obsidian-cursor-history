import { EditHistoryEntry, HistoryEntry, PreviewHistoryEntry } from "./navigation-stack.js";

export enum CompareResult {
  SIMILAR,
  DIFFERENT,
}

export function compareEditSelections(
  a: EditHistoryEntry["selection"],
  b: EditHistoryEntry["selection"],
  editThreshold = 1,
): CompareResult {
  const lineA = Math.min(a.startLine, a.endLine);
  const lineB = Math.min(b.startLine, b.endLine);

  if (Math.abs(lineA - lineB) > editThreshold) {
    return CompareResult.DIFFERENT;
  }
  return CompareResult.SIMILAR;
}

export function comparePreviewSelections(
  a: PreviewHistoryEntry["selection"],
  b: PreviewHistoryEntry["selection"],
  previewThreshold = 10,
): CompareResult {
  // if (a.scrollTop > 0 && b.scrollTop > 0) {
  //   const scrollTopDiff = Math.abs(a.scrollTop - b.scrollTop);
  //   if (scrollTopDiff <= 15) {
  //     return CompareResult.SIMILAR;
  //   }
  // }

  if (a.scrollLine !== 0 || b.scrollLine !== 0) {
    if (Math.abs(a.scrollLine - b.scrollLine) > previewThreshold) {
      return CompareResult.DIFFERENT;
    }
  }

  return CompareResult.SIMILAR;
}

export function shouldCreateNewEntry(
  current: HistoryEntry | null,
  incoming: HistoryEntry,
  editThreshold = 1,
  previewThreshold = 10,
): boolean {
  if (!current) return true;
  if (current.filePath !== incoming.filePath) return true;
  if (current.mode !== incoming.mode) return true;

  if (current.mode === "edit" && incoming.mode === "edit") {
    return compareEditSelections(current.selection, incoming.selection, editThreshold) === CompareResult.DIFFERENT;
  } else if (current.mode === "preview" && incoming.mode === "preview") {
    return comparePreviewSelections(current.selection, incoming.selection, previewThreshold)
      === CompareResult.DIFFERENT;
  }

  return true;
}
