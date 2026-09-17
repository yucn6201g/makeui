import { splitHtmlToFiles, toProjectFiles, type VFile } from './virtualFs';
import { isCompilableProject } from './reactPreview';

export interface ShareBuild {
  html: string | null;
  error: string | null;
}

/** What `buildReactPreview` does, named so this module can be tested without it. */
export type BuildDocument = (files: VFile[]) => Promise<ShareBuild>;

/**
 * The document a share link should serve.
 *
 * A generated project is stored as its own source — a fenced list of
 * `src/App.tsx`, `src/screens/…`, `src/lib/…`. That is what the canvas holds and
 * what the editor edits, and it is NOT a web page: served as one, the browser
 * parses the fence markers as text and silently discards every component tag.
 *
 * Publishing sent exactly that to S3 with `Content-Type: text/html`, so every
 * share link produced since multi-file output shipped has shown the project's
 * source instead of the project. The preview never had this problem because the
 * preview compiles first — this is the same compile, moved in front of the same
 * document.
 *
 * A legacy single-page project has no framework to detect, and for those the
 * stored document IS the page. `isCompilableProject` is the same gate the
 * preview asks, so the two cannot disagree about which kind a document is.
 *
 * A project that will not compile is not published at all. The alternative —
 * publishing something that renders blank, or that paints a Japanese stack trace
 * over a link someone has already sent to a colleague — is worse than being told
 * the link could not be made.
 */
export async function shareDocument(
  html: string | null,
  build: BuildDocument,
  /** The project's name, which becomes the browser tab on the published page. */
  title?: string
): Promise<ShareBuild> {
  if (!html) return { html: null, error: '公開できるドキュメントがありません。' };

  const named = title?.trim();
  const files = named
    ? toProjectFiles(splitHtmlToFiles(html), named)
    : toProjectFiles(splitHtmlToFiles(html));
  if (!isCompilableProject(files)) return { html, error: null };

  let built: ShareBuild;
  try {
    built = await build(files);
  } catch (e) {
    return { html: null, error: `公開用ドキュメントの生成に失敗しました: ${String(e)}` };
  }
  if (built.error) return { html: null, error: `公開用ドキュメントをビルドできませんでした: ${built.error}` };
  if (!built.html) return { html: null, error: '公開用ドキュメントを生成できませんでした。' };
  return { html: built.html, error: null };
}
