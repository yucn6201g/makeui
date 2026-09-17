/**
 * A component's public API, as the files that use it need to see it.
 *
 * This is the failure per-file assembly brings with it, and it is the one that
 * took a whole page down. `DataTable` was written by one call with
 * `{ columns, data, keyExtractor, onRowClick? }`; `InventoryScreen` was written
 * by another and rendered `<DataTable columns={columns} rows={rows} onRowClick=… />`
 * — the wrong name for the data, and no `keyExtractor` at all. Both files are
 * internally correct and both compile. The app threw `keyExtractor is not a
 * function` on first render, the page was blank, and the run scored 30.
 *
 * Nothing in the screen's context could have prevented it. It was given the file
 * list, the route contract and the class vocabulary — and a file list tells you
 * that a component exists, not how to call it.
 *
 * The head of the file rather than a parsed type, because props are declared in
 * the first few lines in all three frameworks (`interface XProps`,
 * `defineProps<…>`, `let { … } = $props()`), and one line count is one thing to
 * keep right where three regexes would be three.
 */

/** Lines of a component worth showing a caller. */
const HEAD_LINES = 24
/** Hard cap, so one file with a very wide props type cannot dominate. */
const MAX_CHARS = 900

export function signatureOf(path: string, body: string): string {
  const head = body
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .slice(0, HEAD_LINES)
    .join('\n')
    .slice(0, MAX_CHARS)
  return `--- ${path} ---\n${head}`
}
