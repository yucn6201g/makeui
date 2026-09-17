/**
 * Search across every file in the project, the way an editor does it.
 *
 * Kept out of the component because it is the part with rules: what counts as a
 * match, what happens to an unfinishable regex, and where the ceiling is. A
 * search box that quietly returns the first N results while looking complete is
 * worse than one that says it stopped.
 */

export interface SearchMatch {
  /** 1-based, so it can be handed straight to the editor. */
  line: number;
  /** The whole line, for context. Trimmed of trailing whitespace only. */
  text: string;
  /** Where the match sits within `text`, for the highlight. */
  start: number;
  end: number;
}

export interface FileHits {
  path: string;
  matches: SearchMatch[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
}

export interface SearchResult {
  files: FileHits[];
  total: number;
  /**
   * True when the ceiling stopped the search. The count above is then a floor,
   * and the UI has to say so — this is the field that keeps it from lying.
   */
  truncated: boolean;
  /** An unusable regular expression, reported rather than treated as no matches. */
  error?: string;
}

/**
 * The most matches to collect.
 *
 * A search for `e` over a project matches tens of thousands of times and the
 * list is useless long before that. The number is arbitrary; that it is
 * reported is not.
 */
export const MAX_MATCHES = 300;

/** A line longer than this is matched but shown clipped, so one minified file cannot freeze the panel. */
const MAX_LINE = 400;

function buildPattern(query: string, opts: SearchOptions): RegExp | string {
  const flags = opts.caseSensitive ? 'g' : 'gi';
  if (!opts.regex) {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  }
  try {
    return new RegExp(query, flags);
  } catch (e) {
    return e instanceof Error ? e.message : '正規表現として読めません';
  }
}

export function searchFiles(
  files: { path: string; content: string }[],
  query: string,
  opts: SearchOptions = {}
): SearchResult {
  if (!query) return { files: [], total: 0, truncated: false };

  const pattern = buildPattern(query, opts);
  if (typeof pattern === 'string') return { files: [], total: 0, truncated: false, error: pattern };

  const out: FileHits[] = [];
  let total = 0;
  let truncated = false;

  for (const file of files) {
    if (truncated) break;
    const matches: SearchMatch[] = [];
    const lines = file.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const text = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(text)) !== null) {
        matches.push({ line: i + 1, text: text.replace(/\s+$/, ''), start: m.index, end: m.index + m[0].length });
        total++;
        if (total >= MAX_MATCHES) { truncated = true; break; }
        // A pattern that can match nothing — `a*` — would sit on one index for
        // ever. Step past it rather than refusing the pattern: it is a legal
        // search, it just has no width here.
        if (m[0].length === 0) pattern.lastIndex++;
      }
      if (truncated) break;
    }
    if (matches.length) out.push({ path: file.path, matches });
  }

  return { files: out, total, truncated };
}
