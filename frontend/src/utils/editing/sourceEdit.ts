import { splitHtmlToFiles, FILE_OPEN, FILE_CLOSE } from '../preview/virtualFs';
import { detectKind } from '../preview/frameworkKind';
/**
 * Writes an edited source file back into the single document everything is
 * stored as.
 *
 * The code view shows a project: folders, files, an index.html. The thing that
 * actually exists is one HTML document carrying `<script data-file="…">` and
 * `<style data-file="…">` blocks, which `splitHtmlToFiles` unpacks for display.
 * Editing means going the other way, and not every file can make the trip:
 *
 *   - a file backed by a data-file block round-trips exactly. Its body is
 *     replaced in place and the opening tag — which carries the path and the
 *     type the rest of the pipeline reads — is left untouched.
 *   - index.html for a single-page mock is *derived*: the extractor replaced its
 *     style and script blocks with <link> and <script src> references. It can
 *     still be edited, by putting the blocks back where the references are.
 *   - index.html for a React project, and every scaffolding file (package.json,
 *     the vite and tsconfig files, the readme), is generated fresh for the
 *     export and stored nowhere. Editing those would change a file that is
 *     rebuilt from scratch the next time anyone looks at it.
 *
 * The third case is the one worth being strict about. Silently accepting an
 * edit that cannot be saved is worse than refusing it: the user watches
 * themselves type into a file, and the change is gone when they come back.
 */

/** Files the export scaffolds rather than stores. Keep in step with `scaffold.ts`. */
const SCAFFOLDED = new Set([
  'package.json',
  'vite.config.ts',
  'vite.config.js',
  'tsconfig.json',
  '.gitignore',
  '.editorconfig',
  'README.md',
  'src/vite-env.d.ts',
  'src/vue-shims.d.ts',
]);

/**
 * Whether the document is a project rather than a single editable page.
 *
 * This was `/data-file=["'][^"']+\.(?:tsx|jsx)["']/` — the transport React
 * projects used before components carrying their own `<script>` forced the move
 * to line fences, and a test that names React while the question is "is this a
 * project". False for every current document, and the consequence is not a
 * cosmetic one: index.html was then reported as editable, and saving it ran
 * `inlineBlocks`, which looks for `[data-file]` elements a fenced project does
 * not have and writes back a document with the references still in it.
 */
function isProject(html: string): boolean {
  return detectKind(splitHtmlToFiles(html)) !== null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The block for a path, with its opening tag kept verbatim. */
/**
 * The region of the document holding one file, in either transport.
 *
 * The fence half was missing, and `blockOf` is what both `editability` and
 * `applyFileEdit` are built on — so for every project generated since the move
 * to line fences, the code editor reported 「このファイルは保存対象に含まれていません」
 * for every file in the tree, and a save returned null. A whole feature, dead
 * for every current document, because one helper still asked the old question.
 *
 * `isProject` immediately above was corrected for exactly this and this was
 * missed, which is the argument for having one predicate rather than two.
 */
function blockOf(html: string, path: string) {
  const tagged = new RegExp(
    `(<(script|style)\\b[^>]*data-file=["']${escapeRe(path)}["'][^>]*>)([\\s\\S]*?)(</\\2>)`,
    'i'
  );
  const m = tagged.exec(html);
  if (m) return { index: m.index, length: m[0].length, open: m[1], body: m[3], close: m[4] };

  /*
   * Located by line rather than by regex, for the same reason `splitHtmlToFiles`
   * is: the fence is a whole line, and a file's own content may contain
   * anything at all — including a line that begins with the opener's prefix.
   * Matching on the exact line is the only test that cannot be fooled by the
   * body it delimits.
   */
  const open = `${FILE_OPEN} ${path}`;
  const lines = html.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (lines[i].trimEnd() === open) start = i;
      continue;
    }
    if (lines[i].trim() !== FILE_CLOSE) continue;
    // Offsets in the original string, so the caller can splice without
    // rebuilding the document and changing every other file's line endings.
    const before = lines.slice(0, start).join('\n');
    const index = start === 0 ? 0 : before.length + 1;
    const whole = lines.slice(start, i + 1).join('\n');
    return {
      index,
      length: whole.length,
      open: lines[start],
      body: lines.slice(start + 1, i).join('\n'),
      close: lines[i],
    };
  }
  return null;
}

interface Editability {
  editable: boolean;
  /** Shown to the user when it is not. */
  reason?: string;
}

export function editability(html: string | null, path: string): Editability {
  if (!html) return { editable: false, reason: 'ドキュメントがありません' };
  if (blockOf(html, path)) return { editable: true };
  if (path === 'index.html') {
    return isProject(html)
      ? {
          editable: false,
          reason: 'index.html はエクスポート時に生成されるファイルです。編集は src/ 以下で行ってください。',
        }
      : { editable: true };
  }
  if (SCAFFOLDED.has(path)) {
    return { editable: false, reason: 'このファイルはエクスポート時に自動生成されるため、保存されません。' };
  }
  return { editable: false, reason: 'このファイルは保存対象に含まれていません。' };
}

/**
 * Puts the extracted blocks back where index.html references them.
 *
 * The references are what `splitHtmlToFiles` left behind, so this is its
 * inverse. The original elements are imported wholesale rather than rebuilt,
 * which keeps every attribute — the path, the `type="text/jsx"` the compiler
 * looks for — exactly as it was. Rebuilding them from remembered parts is how a
 * block quietly loses the attribute that made it meaningful.
 */
function inlineBlocks(currentHtml: string, editedIndex: string): string | null {
  let source: Document;
  let edited: Document;
  try {
    source = new DOMParser().parseFromString(currentHtml, 'text/html');
    edited = new DOMParser().parseFromString(editedIndex, 'text/html');
  } catch {
    return null;
  }
  if (!edited.documentElement) return null;

  const byPath = new Map<string, Element>();
  for (const el of Array.from(source.querySelectorAll('[data-file]'))) {
    const p = el.getAttribute('data-file');
    if (p) byPath.set(p, el);
  }

  for (const link of Array.from(edited.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const original = byPath.get(link.getAttribute('href') ?? '');
    if (original) link.replaceWith(edited.importNode(original, true));
  }
  for (const script of Array.from(edited.querySelectorAll('script[src]'))) {
    const original = byPath.get(script.getAttribute('src') ?? '');
    if (original) script.replaceWith(edited.importNode(original, true));
  }

  const doctype = edited.doctype ? `<!DOCTYPE ${edited.doctype.name}>\n` : '';
  return doctype + edited.documentElement.outerHTML;
}

/**
 * Applies an edit and returns the new document, or null when the file is not
 * one that can be written back.
 */
export function applyFileEdit(html: string, path: string, content: string): string | null {
  const block = blockOf(html, path);
  if (block) {
    return (
      html.slice(0, block.index) +
      block.open + '\n' + content + '\n' + block.close +
      html.slice(block.index + block.length)
    );
  }
  if (path === 'index.html' && !isProject(html)) return inlineBlocks(html, content);
  return null;
}
