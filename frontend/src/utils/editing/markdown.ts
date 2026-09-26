/**
 * Markdown to HTML, for the editor's preview button.
 *
 * Hand-written rather than a dependency, for one reason that decides it: the
 * only markdown this renders is a file the pipeline itself wrote — a
 * SPECIFICATION.md of headings, tables, lists, bold and inline code — and a
 * parser for that is a hundred lines, while a CommonMark implementation is a
 * bundle the preview would carry on every page load to read one file.
 *
 * Everything is escaped BEFORE anything is transformed, and no raw HTML is
 * passed through. That is the whole security argument and it is deliberate:
 * this content is machine-written and lands in the user's own DOM, so the safe
 * reading is that a `<script>` in a markdown file is text about a script. The
 * cost is that intentional inline HTML shows as source, which for a
 * specification document is the right trade.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** `http:` and `https:` only. A `javascript:` href is a script with a costume on. */
function safeHref(raw: string): string | null {
  const url = raw.trim();
  return /^https?:\/\//i.test(url) || url.startsWith('#') || url.startsWith('/') ? url : null;
}

/**
 * Inline formatting for one already-escaped line.
 *
 * Code spans are lifted out first and put back last. Without that, `**` inside
 * a span becomes bold and the span stops saying what it was quoted to say —
 * which in a specification is usually the one part that had to be literal.
 */
function inline(escaped: string): string {
  const spans: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000CODE${spans.length - 1}\u0000`;
  });

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt: string, src: string) => {
    const href = safeHref(src);
    return href ? `<img src="${href}" alt="${alt}" />` : whole;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, target: string) => {
    const href = safeHref(target);
    return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : whole;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/\u0000CODE(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]);
}

const isTableRow = (line: string) => line.trim().startsWith('|');
const isTableRule = (line: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');

/** `| a | b |` → its cells, without the empty ones the outer pipes create. */
function cells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. The body is escaped and otherwise untouched — it is the one
    // place in a markdown file that means itself.
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence, or the end of the file
      const cls = lang ? ` class="md-code md-code--${escapeHtml(lang)}"` : ' class="md-code"';
      out.push(`<pre${cls}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Table: a row, then a rule. Without the rule it is just a line with pipes.
    if (isTableRow(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) body.push(cells(lines[i++]));
      const th = head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('');
      const rows = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? /^(\s*)\d+[.)]\s+(.*)$/.exec(lines[i]) : /^(\s*)[-*+]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[2]))}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // A paragraph runs to the next blank line or the next block that starts one.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length === 0) {
      // A block opener that none of the branches above claimed — a stray `|`
      // row with no rule, for instance. Emit it as text rather than looping.
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br />')}</p>`);
  }

  return out.join('\n');
}
