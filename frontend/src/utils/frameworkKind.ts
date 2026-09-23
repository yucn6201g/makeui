import type { VFile } from './virtualFs';

/**
 * Which framework a set of files is written in — and nothing else.
 *
 * Split out of `frameworkCompile` because that module imports the vendored
 * React and Vue runtimes as text, so anything that wants to ask "what
 * kind of project is this" was pulling megabytes of runtime along with the
 * question. The scaffold, the project list badge and the ZIP export all need the
 * answer and none of them compiles anything.
 *
 * Deliberately still ONE definition. Two copies of this predicate is exactly how
 * the project list came to disagree with the preview about what a document was.
 */

export type OutputKind = 'react' | 'vue';

const KINDS: OutputKind[] = ['react', 'vue'];

export function isOutputKind(value: unknown): value is OutputKind {
  return typeof value === 'string' && KINDS.includes(value as OutputKind);
}

/** A project of this kind, by the files it carries. */
export function detectKind(files: VFile[]): OutputKind | null {
  if (files.some((f) => f.path.endsWith('.vue'))) return 'vue';
  if (files.some((f) => f.path.endsWith('.tsx') || f.path.endsWith('.jsx'))) return 'react';
  return null;
}
