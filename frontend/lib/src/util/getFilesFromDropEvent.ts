/**
 * Copyright (c) Streamlit Inc. (2018-2022) Snowflake Inc. (2022-2026)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Recursively collects all File objects under a FileSystemEntry tree using
 * the Entry API (webkitGetAsEntry / createReader). readEntries returns at most
 * 100 entries per call, so we loop until the batch is empty.
 */
async function collectEntryFiles(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    )
    return [file]
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const all: File[] = []
    let batch: FileSystemEntry[]
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      )
      for (const child of batch) {
        all.push(...(await collectEntryFiles(child)))
      }
    } while (batch.length > 0)
    return all
  }

  return []
}

/**
 * Custom `getFilesFromEvent` for react-dropzone that uses the Entry API
 * (DataTransferItem.webkitGetAsEntry) instead of the File System Access API
 * for folder traversal during drag-and-drop.
 *
 * Why: Chrome's FSA directory walker silently omits entries whose extension
 * appears in Chromium's DANGEROUS blocklist (.ini, .cfg, .lnk, .url, etc.).
 * This is a regression introduced in Streamlit 1.61 when file-selector was
 * upgraded from v2 to v5, which switched folder drops to the FSA path.
 * The Entry API (webkitGetAsEntry / readEntries) applies no such blocklist
 * and is available in every browser that supports drag-and-drop folder uploads.
 *
 * Fallback strategy:
 * - If webkitGetAsEntry() throws or returns null (e.g. single-file drag on
 *   a browser without Entry API), we fall back to item.getAsFile() for that
 *   item only. This preserves the file for single-file drops.
 * - For non-drag events (file <input> change), files are read from the input
 *   element directly.
 *
 * Related: https://github.com/streamlit/streamlit/issues/17234
 *          https://github.com/streamlit/streamlit/issues/6176
 */
export async function getFilesFromDropEvent(
  event: DragEvent | Event
): Promise<Array<File | DataTransferItem>> {
  // Non-drag event: files come from the <input> element, no FSA involved.
  if (!(event instanceof DragEvent) || !event.dataTransfer) {
    const input = event.target as HTMLInputElement | null
    return Array.from(input?.files ?? [])
  }

  const { items } = event.dataTransfer
  if (!items || items.length === 0) {
    // Older browsers without DataTransferItemList — fall back to .files.
    return Array.from(event.dataTransfer.files)
  }

  // Capture entries synchronously — DataTransfer is only live during the event.
  const entryJobs: Array<{ entry: FileSystemEntry } | { item: DataTransferItem }> = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== "file") continue

    let entry: FileSystemEntry | null = null
    try {
      entry = item.webkitGetAsEntry?.() ?? null
    } catch {
      // webkitGetAsEntry can throw in unusual configurations; treat as plain file.
    }

    if (entry) {
      entryJobs.push({ entry })
    } else {
      // No Entry API available for this item — use plain DataTransferItem.
      entryJobs.push({ item })
    }
  }

  // Walk entries asynchronously (DataTransfer has been released; entries persist).
  const fileArrays = await Promise.all(
    entryJobs.map(job =>
      "entry" in job
        ? collectEntryFiles(job.entry)
        : Promise.resolve(
            job.item.getAsFile?.() ? [job.item.getAsFile()!] : []
          )
    )
  )

  return fileArrays.flat()
}
