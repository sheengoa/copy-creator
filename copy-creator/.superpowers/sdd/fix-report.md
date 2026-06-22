# Drag-Reorder Fix Report

## Fixes Applied

### M1 (CRITICAL): App crash when search/filter active

**Problem:** `ClipboardCardInner` unconditionally called `useSortable({ id: record.id })`, but when `isFiltered` was true, `ClipboardCard` was rendered outside `DndContext`. `useSortable` requires `DndContext`/`SortableContext` as ancestors and would throw, crashing the component tree.

**Fix:** Removed the conditional `isFiltered ? ... : <DndContext>` branch. The list is now **always** wrapped in `DndContext` + `SortableContext`. `handleDragEnd` now checks `isFiltered` at the top and returns early, preventing actual drag operations when a filter/search is active.

**Files modified:**
- `src/pages/ClipboardPage/index.tsx`

### M2 (HIGH): Phrase/group sort order inverted after reload

**Problem:** The reorder formula `(n-i)*10` gives the top item the highest `sort_order`. Clipboard queries use `ORDER BY sort_order DESC` (correct), but `get_phrase_groups` and `get_phrases` used `ORDER BY sort_order` (ASC), causing phrase/group order to be inverted after reload.

**Fix:** Changed both queries to use `ORDER BY sort_order DESC`.

**Files modified:**
- `src-tauri/src/db.rs` — `get_phrase_groups` (line 726)
- `src-tauri/src/db.rs` — `get_phrases` (line 798)

### M3 (HIGH): Pagination gap after reorder

**Problem:** After reordering, records got `sort_order = 10, 20, 30...`, but records beyond the loaded page retained `sort_order = timestamp_millis()` (~1.7e12). With `ORDER BY sort_order DESC`, non-loaded records appeared above reordered ones on the next reload.

**Fix:** After a successful `invoke("reorder_clipboard_records", ...)`, `get().loadRecords()` is now called to reload the first page, ensuring consistency between the backend and frontend state. (The error path already did this.)

**Files modified:**
- `src/stores/clipboardStore.ts`

## Verification Results

### TypeScript (`npx tsc --noEmit`)
**PASSED** — No errors.

### Rust (`cargo check`)
**PASSED** — Finished `dev` profile with no warnings or errors.

## Concerns

- M1 fix means drag interactions are now "available" even when filtered, but `handleDragEnd` returns early, so no actual reorder occurs. The `useSortable` hook still registers drag sensors — this should be harmless but means cursor feedback during drag attempts will appear. If users find this confusing, `useSensor` activation constraints could be conditionally disabled when `isFiltered`, but this is a cosmetic concern, not a crash-risk issue.
