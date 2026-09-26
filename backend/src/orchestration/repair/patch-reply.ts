/**
 * A repair reply that carries only the lines it changes.
 *
 * Every per-file repair used to return the COMPLETE file, and output is most of
 * what a generation costs. Measured with `scripts/repair-change-size.mjs` over
 * 14 days and 42 repaired files: a repair changes a median 8% of the file it
 * rewrites (p75 17%, p90 30%), and a search-and-replace reply would still emit
 * about 15% of today's output — under the 40% the script names as the point
 * where building this is worth it. `repair:per-file` was 36% of a generation's
 * tokens and 31% of its output tokens, so this is the largest single thing a
 * run pays for that it does not need.
 *
 * ## The form
 *
 *   <<<<<<< SEARCH
 *   (lines copied from the file)
 *   =======
 *   (the lines that replace them)
 *   >>>>>>> REPLACE
 *
 * The merge-conflict shape, because it is the one a model has seen most often
 * and the one whose markers never occur in a source file by accident.
 *
 * ## Strict about where, lenient about indentation
 *
 * A SEARCH must occur exactly once. Twice is a question of which, and guessing
 * wrong edits a line nobody asked about while reporting the repair as applied.
 * Not at all fails the whole reply rather than applying the blocks that did
 * match — a half-applied repair is a file neither the model nor the audit has
 * seen.
 *
 * Indentation is the one thing forgiven: a block copied with its leading
 * whitespace changed still names one place when compared line by line with
 * whitespace trimmed, and that is the commonest way a copy is inexact. The
 * replacement is re-indented by the difference, so the file keeps its own.
 *
 * A reply with no blocks at all is a whole file, which the prompt still allows
 * for a repair that rewrites most of one. The caller treats it exactly as every
 * reply was treated before this existed.
 */

/*
 * Markers on their own lines, with trailing spaces allowed. The first measured
 * round had four replies that carried markers and matched no block; a marker
 * followed by a space is the likeliest reading of that, and it costs nothing to
 * accept.
 */
const BLOCK = /^<{7} SEARCH[ \t]*\n([\s\S]*?)\n?^={7}[ \t]*\n([\s\S]*?)\n?^>{7} REPLACE[ \t]*$/gm;

/**
 * A file small enough that the blocks cost more than the file.
 *
 * A patch reply has a fixed overhead — the markers, and enough surrounding
 * lines for each SEARCH to occur exactly once — which a 400-line stylesheet
 * absorbs and a 20-line button does not. Measured over 60 days on the files
 * production actually patched: every one under 1,100 characters cost MORE than
 * sending it whole, and the two worst were a 289-character Header that replied
 * with 3,717 characters and a 400-character routes.ts that replied with 5,579.
 *
 * Here rather than beside either caller, because the repair path and the edit
 * path ask for the same form and the floor is a property of the form.
 */
export const MIN_PATCH_CHARS = 2_000;

/**
 * Whether a reply is written as blocks rather than as a file.
 *
 * Any marker at all counts. A reply with a SEARCH marker that does not parse is
 * a malformed patch, and read as a whole file it is certain not to compile —
 * which is how two repairs in the first measured round were thrown away as
 * `does not parse (1:3)`. As a failed patch it gets the whole-file retry.
 */
export function isPatchReply(reply: string): boolean {
  return /<{7} SEARCH/.test(reply);
}

type PatchResult =
  | { ok: true; body: string; blocks: number }
  | { ok: false; error: string; blocks: number };

/** The prompt text that asks for this form. One copy, so the parser and the ask cannot drift. */
export const PATCH_REPLY_RULES = `- Reply with SEARCH/REPLACE blocks that change only what the defects need:
<<<<<<< SEARCH
(lines copied from the current contents, exactly — usually 2 to 6 lines, enough to occur only once)
=======
(the lines that replace them)
>>>>>>> REPLACE
  Use as many blocks as the fix needs, in file order, and nothing outside them:
  no markdown, no fences, no commentary. SEARCH must match the current contents
  character for character and occur exactly once in the file. To ADD code, SEARCH
  for the neighbouring line and repeat it in REPLACE together with the addition.
  To DELETE code, leave REPLACE empty.
- Only when the fix rewrites most of the file, return the COMPLETE corrected file
  instead, with no blocks.`;

export function applyPatchReply(original: string, reply: string): PatchResult {
  const text = reply.replace(/\r\n/g, '\n');
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length === 0) return { ok: false, error: 'no SEARCH/REPLACE block could be read', blocks: 0 };

  let body = original.replace(/\r\n/g, '\n');
  for (let i = 0; i < blocks.length; i += 1) {
    const search = blocks[i][1] ?? '';
    const replace = blocks[i][2] ?? '';
    if (search.trim() === '') {
      return { ok: false, error: `block ${i + 1}: SEARCH is empty`, blocks: blocks.length };
    }
    const exact = body.indexOf(search);
    if (exact !== -1) {
      if (body.indexOf(search, exact + 1) !== -1) {
        return { ok: false, error: `block ${i + 1}: SEARCH occurs more than once`, blocks: blocks.length };
      }
      body = body.slice(0, exact) + replace + body.slice(exact + search.length);
      continue;
    }
    const loose = replaceByTrimmedLines(body, search, replace);
    if (loose.body === undefined) return { ok: false, error: `block ${i + 1}: ${loose.error}`, blocks: blocks.length };
    body = loose.body;
  }
  return { ok: true, body, blocks: blocks.length };
}

/** The same search, line by line with leading and trailing whitespace ignored. */
function replaceByTrimmedLines(body: string, search: string, replace: string): { body: string; error?: undefined } | { body?: undefined; error: string } {
  const lines = body.split('\n');
  const want = search.split('\n').map((l) => l.trim());
  while (want.length > 0 && want[want.length - 1] === '') want.pop();
  while (want.length > 0 && want[0] === '') want.shift();
  if (want.length === 0) return { error: 'SEARCH is empty' };

  const hits: number[] = [];
  for (let start = 0; start + want.length <= lines.length; start += 1) {
    let match = true;
    for (let k = 0; k < want.length; k += 1) {
      if (lines[start + k].trim() !== want[k]) { match = false; break; }
    }
    if (match) hits.push(start);
    if (hits.length > 1) return { error: 'SEARCH occurs more than once' };
  }
  if (hits.length === 0) return { error: 'SEARCH does not match the file' };

  const start = hits[0];
  /*
   * Re-indented by the difference between the file's first matched line and the
   * block's, so a block copied two spaces shallower lands at the file's depth.
   */
  const firstSearch = search.split('\n').find((l) => l.trim() !== '') ?? '';
  const fileIndent = /^\s*/.exec(lines[start])?.[0] ?? '';
  const blockIndent = /^\s*/.exec(firstSearch)?.[0] ?? '';
  const shift = (line: string): string => {
    if (line.trim() === '') return line;
    if (blockIndent && line.startsWith(blockIndent)) return fileIndent + line.slice(blockIndent.length);
    return fileIndent.length > blockIndent.length ? fileIndent.slice(blockIndent.length) + line : line;
  };
  const replacement = replace === '' ? [] : replace.split('\n').map(shift);
  lines.splice(start, want.length, ...replacement);
  return { body: lines.join('\n') };
}
