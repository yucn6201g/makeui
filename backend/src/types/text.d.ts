/**
 * Text imports, resolved by esbuild's `--loader:.txt=text`.
 *
 * Used for the vendored React UMD builds, which are inlined into the bundle
 * rather than read from disk at runtime — see scripts/vendor-react.mjs.
 */
declare module '*.txt' {
  const content: string;
  export default content;
}

/**
 * Vue's browser build, imported by path so the bundler skips the Node entry —
 * that one pulls in `consolidate`, whose optional template engines are not
 * installed and cannot be resolved. Types come from the package's own root.
 */
declare module '@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js' {
  export * from '@vue/compiler-sfc';
}
