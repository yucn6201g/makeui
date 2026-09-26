import type { Lang } from '../editing/codeHighlight';

export interface VFile {
  path: string;
  content: string;
  lang: Lang;
}

/** Strip one level of common leading indentation so extracted blocks read cleanly. */
function dedent(code: string): string {
  const lines = code.replace(/^\n+|\s+$/g, '').split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent < min) min = indent;
  }
  if (!isFinite(min) || min === 0) return lines.join('\n');
  return lines.map((l) => (l.trim() ? l.slice(min) : l)).join('\n');
}

/** Ensure a filename is unique within the set already claimed. */
function unique(claimed: Set<string>, preferred: string): string {
  if (!claimed.has(preferred)) {
    claimed.add(preferred);
    return preferred;
  }
  const dot = preferred.lastIndexOf('.');
  const stem = dot === -1 ? preferred : preferred.slice(0, dot);
  const ext = dot === -1 ? '' : preferred.slice(dot);
  let n = 2;
  while (claimed.has(`${stem}-${n}${ext}`)) n++;
  const name = `${stem}-${n}${ext}`;
  claimed.add(name);
  return name;
}

const LANG_BY_EXT: Record<string, Lang> = {
  html: 'html', css: 'css', js: 'js', mjs: 'js',
  jsx: 'jsx', tsx: 'tsx', ts: 'ts', json: 'json', md: 'md',
};

/** Pick a highlighter language from the declared file path. */
function langOf(path: string, fallback: Lang): Lang {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? fallback;
}

/**
 * Split a single generated HTML document into a virtual multi-file project.
 *
 * The generator emits `<style data-file="...">` / `<script data-file="...">` blocks;
 * each becomes its own file and is replaced in index.html by a normal
 * `<link>` / `<script src>` reference, so the markup reads like a real project.
 * Blocks without `data-file` fall back to generic names.
 */
/**
 * The line fence a project uses when its source cannot live inside HTML tags.
 *
 * A Vue or Svelte component contains its own `<script>`, so the DOM parser below
 * ends the carrier at the component's tag and hands back half a file. The fence
 * is a whole line, and a line of source is never exactly it.
 */
export const FILE_OPEN = '@@@makeui:file';
export const FILE_CLOSE = '@@@makeui:endfile';

/** The one test for "is this line a fence opener", used by both readers below. */
function opensFile(line: string): boolean {
  return line.trimEnd().startsWith(`${FILE_OPEN} `);
}

/**
 * Whether a document is in the fenced transport.
 *
 * Deliberately not a regex. This was `new RegExp(\`^${FILE_OPEN}\\s\`, 'm')`
 * written with a single backslash, and inside a template literal `\s` is an
 * unknown escape — the backslash is dropped and the pattern compiles to
 * `^@@@makeui:files`, which cannot match `@@@makeui:file ` and so never matched
 * anything. Every fenced project fell through to the DOM parser, arrived as one
 * `index.html`, and rendered in the preview as its own source text with the JSX
 * elements silently eaten by the HTML parser.
 *
 * Sharing `opensFile` with the splitter is what stops the detector and the
 * reader from disagreeing again: if this says yes, the splitter finds the same
 * line.
 */
function isFencedDocument(source: string): boolean {
  return source.split('\n').some(opensFile);
}

function splitFenced(source: string): VFile[] {
  const files: VFile[] = [];
  let path: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (path) files.push({ path, content: body.join('\n'), lang: langOf(path, 'js') });
  };
  for (const line of source.split('\n')) {
    const trimmed = line.trimEnd();
    if (opensFile(line)) {
      flush();
      path = trimmed.slice(FILE_OPEN.length + 1).trim();
      body = [];
      continue;
    }
    if (trimmed === FILE_CLOSE) {
      flush();
      path = null;
      body = [];
      continue;
    }
    if (path) body.push(line);
  }
  flush();
  return files;
}

export function splitHtmlToFiles(html: string | null): VFile[] {
  // Read first and exclusively when present: a document is one shape or the
  // other, and parsing both would let a `<script>` inside a fenced component
  // register as a second, bogus file.
  if (html && isFencedDocument(html)) return splitFenced(html);
  if (!html || !html.trim()) return [];

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [{ path: 'index.html', content: html, lang: 'html' }];
  }
  if (!doc.documentElement) return [{ path: 'index.html', content: html, lang: 'html' }];

  const files: VFile[] = [];
  const claimed = new Set<string>(['index.html']);

  for (const el of Array.from(doc.querySelectorAll('style'))) {
    const content = dedent(el.textContent ?? '');
    if (!content) {
      el.remove();
      continue;
    }
    const declared = el.getAttribute('data-file')?.trim();
    const path = unique(claimed, declared || 'styles/main.css');
    files.push({ path, content, lang: langOf(path, 'css') });

    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', path);
    el.replaceWith(link);
  }

  for (const el of Array.from(doc.querySelectorAll('script'))) {
    if (el.getAttribute('src')) continue; // already an external reference
    const content = dedent(el.textContent ?? '');
    if (!content) {
      el.remove();
      continue;
    }
    const declared = el.getAttribute('data-file')?.trim();
    const path = unique(claimed, declared || 'scripts/main.js');
    files.push({ path, content, lang: langOf(path, 'js') });

    // Documentation travels in a <script> block only because that is the transport
    // — it is not code. Referencing it back from index.html would make the exported
    // page try to execute Markdown as JavaScript, so the carrier is simply dropped.
    if (/\.(md|markdown|txt)$/i.test(path) || /markdown|text\/plain/i.test(el.getAttribute('type') ?? '')) {
      el.remove();
      continue;
    }

    const tag = doc.createElement('script');
    tag.setAttribute('src', path);
    el.replaceWith(tag);
  }

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : '';
  files.unshift({
    path: 'index.html',
    content: doctype + doc.documentElement.outerHTML,
    lang: 'html',
  });

  // index.html first, then folders alphabetically, files within a folder in emit order.
  const rest = files.slice(1);
  rest.sort((a, b) => {
    const da = a.path.includes('/') ? a.path.slice(0, a.path.lastIndexOf('/')) : '';
    const db = b.path.includes('/') ? b.path.slice(0, b.path.lastIndexOf('/')) : '';
    return da === db ? 0 : da.localeCompare(db);
  });

  return [files[0], ...rest];
}

export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
  file?: VFile;
}

/**
 * Group flat file paths into a genuinely nested folder tree.
 *
 * Each path segment becomes its own node, so "src/app/components/Nav.tsx" nests
 * four levels deep and each level can be collapsed independently — the previous
 * version produced one node per full directory, which read as a flat list of
 * long folder names.
 *
 * Ordering follows the convention editors use: folders before files, each group
 * sorted case-insensitively.
 */
export function buildTree(files: VFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };

  for (const file of files) {
    const segments = file.path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const dirPath = segments.slice(0, i + 1).join('/');
      let next = node.children!.find((c) => c.children && c.path === dirPath);
      if (!next) {
        next = { name: segments[i], path: dirPath, children: [] };
        node.children!.push(next);
      }
      node = next;
    }
    node.children!.push({ name: segments[segments.length - 1], path: file.path, file });
  }

  const sortLevel = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = !!a.children;
      const bDir = !!b.children;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const n of nodes) if (n.children) sortLevel(n.children);
    return nodes;
  };

  return sortLevel(root.children!);
}
