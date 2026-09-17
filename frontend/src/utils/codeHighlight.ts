export type Lang = 'html' | 'css' | 'js' | 'jsx' | 'tsx' | 'ts' | 'json' | 'md';

export interface Tok {
  t: string;
  c: string;
}

/** VS Code Dark+ token classes. Empty string = plain text. */
const JS_MAP: Record<string, string> = {
  jscomment: 'cm',
  jsstring: 'st',
  jskeyword: 'kw',
  jsliteral: 'lt',
  jsnumber: 'nu',
  jsfunc: 'fn',
  jsclass: 'cl',
  jspunct: 'pu',
};

const JS_RE = new RegExp(
  [
    '(?<jscomment>\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)',
    '(?<jsstring>"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
    '(?<jskeyword>\\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|new|class|extends|import|export|from|default|try|catch|finally|throw|typeof|instanceof|await|async|yield|switch|case|delete|void|in|of)\\b)',
    '(?<jsliteral>\\b(?:true|false|null|undefined|this|NaN|Infinity)\\b)',
    '(?<jsnumber>\\b0[xX][0-9a-fA-F]+\\b|\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)',
    '(?<jsfunc>\\b[A-Za-z_$][\\w$]*(?=\\s*\\())',
    '(?<jsclass>\\b[A-Z][\\w$]*\\b)',
    '(?<jspunct>[{}()\\[\\];,.:?=+\\-*/%<>!&|^~]+)',
  ].join('|'),
  'g'
);

const CSS_MAP: Record<string, string> = {
  csscomment: 'cm',
  cssstring: 'st',
  cssat: 'at',
  cssvar: 'pr',
  csshex: 'st',
  cssnum: 'nu',
  cssprop: 'pr',
  cssfunc: 'fn',
  csssel: 'se',
  csspunct: 'pu',
};

const CSS_RE = new RegExp(
  [
    '(?<csscomment>\\/\\*[\\s\\S]*?\\*\\/)',
    '(?<cssstring>"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')',
    '(?<cssat>@[\\w-]+)',
    '(?<cssvar>--[\\w-]+)',
    '(?<csshex>#[0-9a-fA-F]{3,8}\\b)',
    '(?<cssnum>\\b\\d*\\.?\\d+(?:px|rem|em|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|pt|ex)?\\b)',
    '(?<cssprop>[-a-zA-Z]+(?=\\s*:))',
    '(?<cssfunc>\\b[\\w-]+(?=\\())',
    '(?<csssel>[.#][\\w-]+|::?[a-zA-Z][\\w-]*)',
    '(?<csspunct>[{}();:,>~+*]+)',
  ].join('|'),
  'g'
);

const HTML_MAP: Record<string, string> = {
  htmlcomment: 'cm',
  htmldoctype: 'cm',
  htmltag: 'tg',
  htmlattr: 'at2',
  htmlstring: 'st',
  htmlpunct: 'pu',
};

const HTML_RE = new RegExp(
  [
    '(?<htmlcomment><!--[\\s\\S]*?-->)',
    '(?<htmldoctype><!DOCTYPE[^>]*>)',
    '(?<htmltag><\\/?[a-zA-Z][\\w-]*)',
    '(?<htmlattr>[a-zA-Z-][\\w-]*(?=\\s*=))',
    '(?<htmlstring>"[^"]*"|\'[^\']*\')',
    '(?<htmlpunct>\\/?>)',
  ].join('|'),
  'g'
);

function run(code: string, re: RegExp, map: Record<string, string>): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(code)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ t: code.slice(last, m.index), c: '' });

    let cls = '';
    const groups = m.groups ?? {};
    for (const key in groups) {
      if (groups[key] !== undefined) {
        cls = map[key] ?? '';
        break;
      }
    }
    out.push({ t: m[0], c: cls });
    last = m.index + m[0].length;
  }

  if (last < code.length) out.push({ t: code.slice(last), c: '' });
  return out;
}

function tokenize(code: string, lang: Lang): Tok[] {
  // JSX/TSX embed markup in JS; the JS tokenizer reads them acceptably and keeps
  // the highlighter to one small grammar rather than a full JSX parser.
  if (lang === 'js' || lang === 'jsx' || lang === 'tsx' || lang === 'ts' || lang === 'json') {
    return run(code, JS_RE, JS_MAP);
  }
  if (lang === 'css') return run(code, CSS_RE, CSS_MAP);
  if (lang === 'md') return [{ t: code, c: '' }];
  return run(code, HTML_RE, HTML_MAP);
}

/** Tokenize and split into per-line token arrays for line-numbered rendering. */
export function highlightLines(code: string, lang: Lang): Tok[][] {
  const lines: Tok[][] = [[]];
  for (const tok of tokenize(code, lang)) {
    const parts = tok.t.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i] !== '') lines[lines.length - 1].push({ t: parts[i], c: tok.c });
    }
  }
  return lines;
}
