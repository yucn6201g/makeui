/// <reference types="vite/client" />

// Framework runtimes are inlined into the preview iframe as text — the sandbox
// blocks external requests, so they cannot be fetched. They arrive through the
// `framework-runtimes` plugin in vite.config.ts and have no types of their own.
/**
 * React and ReactDOM in one bundle, because they must share one copy of React.
 * React 19 has no UMD build; this is esbuild's IIFE of both. See vite.config.ts.
 */
declare module 'virtual:react-runtime' {
  const content: string;
  export default content;
}

declare module 'virtual:vue-global' {
  const content: string;
  export default content;
}

/** Svelte's runtime is many ESM modules, so this one is bundled at build time. */
declare module 'virtual:svelte-runtime' {
  const content: string;
  export default content;
}
