/**
 * Deterministic repairs for how modules fit together: imports that do not match
 * the export, an import written half as a require, an arrow function cast without
 * parentheses, and the last resorts for a style block or a component that will not
 * build, so one broken file costs that file rather than the application.
 */
import { FRAMEWORKS, type OutputKind } from '../../config/frameworks.js'
import { readProjectFiles, writeProjectFile } from '../project/project-transport.js'

/**
 * Last resort: one component that will not build costs that component, not the
 * application.
 *
 * A project is compiled as a unit, so a single unparseable file has always meant
 * a blank page — every screen gone because one icon had a stray brace. Every
 * repair above exists because a specific idiom was measured doing exactly that,
 * and three sessions running, the next generation found a different one:
 *
 *     v145   a class-based router               (our bug — Sucrase lowering)
 *     v151   {width={size}} in one icon of nine
 *     v153   {#const …} in two screens
 *
 * Each was fixed, and each time the following run failed on something new. The
 * list of known mistakes is not converging fast enough to be the whole answer,
 * and the requirement it serves does not bend: a generated UI must never fail to
 * display.
 *
 * So this handles the class instead of the instance. When the project still will
 * not compile after every deterministic repair, the file the compiler blames is
 * replaced with a component that renders a labelled placeholder. The rest of the
 * application builds and runs: the navigation works, the other screens work, and
 * the one broken piece says so on the page.
 *
 * Deliberately narrow:
 *  - Components only. A `.svelte.ts` store or a `lib/` module is imported for the
 *    values it exports, and a stub of it breaks every file that reads it —
 *    trading one failure for several. Those keep the build error, which the
 *    preview shows as a readable message rather than a blank pane.
 *  - Never the entry or the shell. Stubbing `App` leaves an application with no
 *    navigation and nothing in it, which is not better than the error.
 *  - Never a file with named exports (React only in practice): something else
 *    imports those by name, and the stub would not have them.
 *  - It stops as soon as the project builds, so a sound document is untouched.
 *
 * The placeholder is visible on purpose. A silently missing card would leave the
 * user hunting for a screen that never rendered; a dashed box naming the file
 * says what happened and where.
 */
export function stubUnbuildableComponents(
  html: string,
  kind: OutputKind,
  compile: (html: string, kind: OutputKind) => { error?: string | null }
): { html: string; stubbed: string[]; reasons: { path: string; error: string }[] } {
  const fw = FRAMEWORKS[kind]
  const stubbed: string[] = []
  /*
   * Why each one was replaced, kept so the placeholder is not a diagnostic dead
   * end.
   *
   * Measured at v160: all three screens of a Svelte project were stubbed, the
   * application rendered its shell and navigation with a placeholder where every
   * screen should have been, and the only record was a list of three filenames.
   * Three failures with one probable cause, and nothing anywhere said what it
   * was — the stub had replaced the evidence along with the fault.
   */
  const reasons: { path: string; error: string }[] = []
  let out = html

  for (let guard = 0; guard < 8; guard++) {
    const error = compile(out, kind)?.error
    if (!error) break

    const named = new RegExp(`(src/[\\w./-]+\\${fw.componentExt})`).exec(error)?.[1]
    if (!named || stubbed.includes(named)) break

    // The entry and the shell are the application; a stub of either is not a
    // smaller failure than the error.
    if (named === fw.entry || new RegExp(`^src/App\\${fw.componentExt}$`).test(named)) break

    const files = readProjectFiles(out)
    const body = files.get(named)
    if (!body) break

    /*
     * Something may import a named export from this file, and the stub will not
     * have it.
     *
     * What counts as a named export differs by framework, and reading React's
     * rule into the others is wrong in a way that matters: inside a .svelte
     * file `export let variant = 'primary'` declares a PROP, not a module
     * export, and nothing imports it by name. Measured — a component whose only
     * "exports" were four Svelte 4 props was skipped, and its project stayed a
     * blank page for no reason.
     *
     * For Svelte a real named export lives in a module script; for Vue, in a
     * plain `<script>` beside the setup block. Both are rare in generated code.
     */
    const hasNamedExport =
      kind === 'react'
        ? /^\s*export\s+(?:const|function|class|let)\s+\w/m.test(body)
        : /<script\b[^>]*\b(?:module|context=["']module["'])[^>]*>/.test(body)
    if (hasNamedExport) break

    const written = writeProjectFile(out, named, componentStub(kind, named))
    if (written === null) break

    out = written
    stubbed.push(named)
    reasons.push({ path: named, error: error.split('\n')[0].slice(0, 300) })
  }

  return { html: out, stubbed, reasons }
}

/**
 * The files a build error names, whether or not a stub could replace them.
 *
 * `stubUnbuildableComponents` finds them too, and then declines on the entry,
 * the shell, a module, and anything with a named export — correctly, because a
 * placeholder for any of those is not a smaller failure than the error. It
 * reports nothing in those cases, which is right for stubbing and wrong for
 * everything else: repairing App.svelte is not only possible, it is the case
 * where repairing matters most, since nothing else can rescue it.
 *
 * Measured on v195. Svelte put an `{@const}` where Svelte does not allow one,
 * in App.svelte. Nothing could be stubbed, so the build-error repair — gated on
 * the stub having found something — never ran, and a project with five screens
 * and seventeen components rendered nothing at all and scored its floor.
 *
 * One name per compile, and the file is stubbed internally only to move past it
 * and see what the next error is. The stubbed document is thrown away; the
 * caller gets paths and messages.
 */
export function unbuildableFiles(
  html: string,
  kind: OutputKind,
  compile: (html: string, kind: OutputKind) => { error?: string | null }
): { path: string; error: string }[] {
  const fw = FRAMEWORKS[kind]
  const found: { path: string; error: string }[] = []
  let out = html

  for (let guard = 0; guard < 8; guard++) {
    const error = compile(out, kind)?.error
    if (!error) break
    /*
     * Longest extension first, and only at a boundary.
     *
     * Two ways to get the wrong path out of a right message. `.svelte` tried
     * before `.ts` truncates `src/lib/store.svelte.ts` to `src/lib/store.svelte`;
     * `ts` tried before `tsx` truncates `Card.tsx` to `Card.ts`. Either way a
     * repair is handed a file the project does not have and can only fail on it.
     */
    const named = new RegExp(
      `(src/[\\w./-]+\\.(?:tsx|jsx|ts|js)(?![\\w.])|src/[\\w./-]+\\${fw.componentExt}(?![\\w.]))`
    ).exec(error)?.[1]
    if (!named || found.some((f) => f.path === named)) break
    found.push({ path: named, error: error.split('\n')[0].slice(0, 300) })
    // Only to reach the next error. This document is never returned.
    const written = writeProjectFile(out, named, componentStub(kind, named))
    if (written === null) break
    out = written
  }
  return found
}

/** A component of this framework that renders a labelled placeholder. */
function componentStub(kind: OutputKind, path: string): string {
  const name = path.split('/').pop() ?? path
  const note = `${name} はビルドできなかったため、この部分だけ差し替えられています`
  // Inline styles rather than a class: the stylesheet may not define one, and
  // this has to be visible in a project it knows nothing about.
  const style =
    'padding:16px;border:1px dashed #b45309;border-radius:8px;' +
    'background:#fffbeb;color:#92400e;font-size:13px;line-height:1.6'

  if (kind === 'vue') {
    return `<template>\n  <div style="${style}">${note}</div>\n</template>\n`
  }
  return (
    `export default function BrokenComponent(_props: Record<string, unknown>) {\n` +
    `  return (\n` +
    `    <div style={{ padding: 16, border: '1px dashed #b45309', borderRadius: 8,\n` +
    `                  background: '#fffbeb', color: '#92400e', fontSize: 13, lineHeight: 1.6 }}>\n` +
    `      ${note}\n` +
    `    </div>\n` +
    `  );\n` +
    `}\n`
  )
}

/**
 * Last resort: a component's `<style>` block that will not parse loses the
 * block, rather than the application losing the page.
 *
 * Every targeted repair above exists because a specific idiom was measured
 * reaching a user as a blank page. Three consecutive Svelte runs failed to
 * build for three unrelated reasons, and only one of them was foreseen. The
 * targeted repairs are still worth having — they preserve the code the model
 * wrote — but a list of known mistakes cannot be complete, and the requirement
 * it serves is absolute: a generated UI must never fail to display.
 *
 * So this handles the class rather than the instance, for the one part of a
 * component that can be removed without changing what the component does.
 * `src/styles/globals.css` is the design by contract — it carries the tokens,
 * the shell, and every shape a screen uses — which makes a scoped block
 * supplementary. Dropping one costs some polish on one component. Keeping it
 * costs the entire interface.
 *
 * Deliberately conservative:
 *  - Only when the document does not compile at all.
 *  - Only when the compiler blames CSS. A block is never removed to work around
 *    an error in the script, because that would hide a real fault behind a
 *    cosmetic change and still not build.
 *  - Only the file the compiler names.
 *  - It stops as soon as the project builds, so a document that compiles is
 *    returned exactly as it came in.
 */
export function salvageUnparsableStyles(
  html: string,
  kind: OutputKind,
  compile: (html: string, kind: OutputKind) => { error?: string | null }
): { html: string; stripped: string[] } {
  const stripped: string[] = []
  let out = html

  for (let guard = 0; guard < 6; guard++) {
    const error = compile(out, kind).error
    if (!error) break
    // Svelte reports `css_expected_identifier` and friends, and links to
    // svelte.dev/e/css_*; Vue's SFC compiler names the block outright.
    if (!/\bcss[_\s-]|CSS|<style/i.test(error)) break

    const named = /(src\/[\w./-]+\.(?:vue))/.exec(error)?.[1]
    if (!named || stripped.includes(named)) break

    const files = readProjectFiles(out)
    const body = files.get(named)
    if (!body || !/<style[\s>]/.test(body)) break

    const next = body.replace(/\n?[ \t]*<style[^>]*>[\s\S]*?<\/style>[ \t]*\n?/g, '\n')
    if (next === body) break

    // Refuses the write if the body would break the transport. Nothing here can
    // produce that — removing a block cannot introduce a fence — but the whole
    // point of this function is to be the step that never makes things worse.
    const written = writeProjectFile(out, named, next)
    if (written === null) break

    out = written
    stripped.push(named)
  }

  return { html: out, stripped }
}

/**
 * A default export pulled in by name through `require`.
 *
 *     // src/components/icons/ClockIcon.tsx
 *     export default function ClockIcon({ size }) { … }
 *
 *     // src/screens/ApplicationsScreen.tsx
 *     const { ClockIcon } = require('../components/icons/ClockIcon');
 *     …
 *     return <ClockIcon size={12} />;
 *
 * The module has no named `ClockIcon`, so the binding is `undefined` and React
 * refuses to render it:
 *
 *     Minified React error #130  (element type is invalid: got undefined)
 *
 * Measured at v172, on a screen whose other seven imports were ordinary ESM at
 * the top of the file. Three icons were reached this way, mid-function.
 *
 * It survives the checks for the same reason the markdown fence did: nothing
 * here is malformed. The module resolves, the destructuring succeeds, and the
 * value is simply not there. `unresolvedComponentDefects` skips React on the
 * reasoning that an undefined JSX name is already a reference error — true of a
 * free identifier, and this is a declared `const` bound to undefined.
 *
 * Rewritten to read the default, which is the export that exists:
 *
 *     const ClockIcon = require('../components/icons/ClockIcon').default;
 *
 * Left in place rather than hoisted to an import — a `require` inside a
 * function runs when it is called, and moving it changes when the module is
 * evaluated. Only when the target actually has a default export and no named
 * export of that name: a module offering both is doing so deliberately.
 */
export function fixRequireNamedDefault(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const fixed: string[] = []
  const out = new Map(files)

  const resolve = (from: string, spec: string): string | undefined => {
    const dir = from.slice(0, from.lastIndexOf('/'))
    const parts = `${dir}/${spec}`.split('/')
    const stack: string[] = []
    for (const p of parts) {
      if (p === '.' || p === '') continue
      if (p === '..') stack.pop()
      else stack.push(p)
    }
    const base = stack.join('/')
    return [...files.keys()].find((k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue)$/, '') === base)
  }

  for (const [path, body] of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(path)) continue
    let next = out.get(path) ?? body
    let touched = false

    next = next.replace(
      /(?:const|let|var)\s*\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g,
      (whole, name: string, spec: string) => {
        const target = resolve(path, spec)
        if (!target) return whole
        const t = files.get(target) ?? ''
        if (!/export\s+default\b/.test(t)) return whole
        // A module that exports both is offering the named one on purpose.
        if (new RegExp(`export\\s+(?:const|function|class)\\s+${name}\\b`).test(t)) return whole
        touched = true
        fixed.push(`${name} (${path})`)
        return `const ${name} = require('${spec}').default`
      }
    )

    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          `default export を名前で require していたため .default に変更（undefined が描画され React error #130 になります）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

/**
 * A local binding that turns a rune back into a store read.
 *
 *     const state = appStore;
 *     let currentScreen = $state('home');
 *
 * compiles to
 *
 *     const $state = () => $.store_get(state, '$state', $$stores);
 *     let currentScreen = $.mutable_source($state()('home'));
 *
 *     TypeError: e.subscribe is not a function
 *
 * `$name` is a store subscription whenever `name` is in scope, and that rule
 * outranks the rune. So naming a variable `state` silently disables `$state` for
 * the rest of the file — the component still compiles, and dies on mount.
 * Measured at v178.
 *
 * `fixSvelteRuneShadowing` already handles this for exported names, where the
 * rename has to reach every importer. A local binding is the easier half: the
 * shadow cannot leave the file, so neither does the fix.
 *
 * Only when the rune is actually used — an unrelated `state` variable in a file
 * with no `$state` shadows nothing — and never for a name that came out of
 * `$props()`, where the name is a contract with the parent.
 */

/**
 * An import written half as an import and half as a require.
 *
 *     import { route, navigate } = require('./lib/navigation.svelte');
 *
 *     Error transforming src/App.svelte: Unexpected token (6:30)
 *
 * Neither language has this form: `import { … }` wants `from`, and `= require()`
 * wants a `const`. Column 30 is the `=`. It sits among five correct `import …
 * from` lines in the same block, which is what makes it easy to write and easy
 * to miss.
 *
 * Measured at v179. The repair is the line the rest of the file is already
 * written in — the module specifier is right there, so nothing has to be
 * inferred.
 */
export function fixImportRequireHybrid(source: string): { source: string; fixed: string[] } {
  const fixed: string[] = []
  const out = source.replace(
    /import\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)\s*;?/g,
    (_whole, binding: string, quote: string, spec: string) => {
      fixed.push(spec)
      return `import ${binding} from ${quote}${spec}${quote};`
    }
  )
  return {
    source: out,
    fixed: fixed.length
      ? [
          `import と require が混ざった行を import ... from に統一（どちらの構文でもないため構文エラーになります）: ${[
            ...new Set(fixed),
          ].join(', ')}`,
        ]
      : [],
  }
}

/**
 * A default import of a file that only has named exports.
 *
 *     // src/components/icons/TrendIcon.tsx
 *     export function TrendIcon({ direction, size = 16 }) { … }
 *
 *     // src/components/KPICards.tsx
 *     import TrendIcon from './icons/TrendIcon.js';
 *
 *     Minified React error #130  (element type is invalid: got undefined)
 *
 * The module has no default, so the binding is `undefined` and the element
 * refuses to render — the same silent shape as `fixRequireNamedDefault`, in the
 * spelling ESM uses. Both halves are ordinary: the component is exported, the
 * importer names it correctly, and only the form disagrees.
 *
 * Measured at v185, on the run where the icons and illustrations instructions
 * first took effect. Two of the three occurrences were in exactly those new
 * files — asking for more components produced more of them and a new way for
 * them to be wired up wrong, which is worth saying plainly.
 *
 * The importer is what changes, because the export is what other files may
 * already be reading correctly. When the local name differs from the export —
 * `import EmptyStateIllustration from './illustrations/EmptyState.js'` — the alias
 * form keeps every use in the file working untouched.
 *
 * Only when the target offers exactly one component-shaped export. Two would be
 * a guess about which was meant, and none means the file is broken in a way
 * this cannot repair.
 */
export function fixDefaultImportOfNamedExport(files: Map<string, string>): {
  files: Map<string, string>
  fixed: string[]
} {
  const fixed: string[] = []
  const out = new Map(files)

  const resolve = (from: string, spec: string): string | undefined => {
    const dir = from.slice(0, from.lastIndexOf('/'))
    const stack: string[] = []
    for (const seg of `${dir}/${spec}`.split('/')) {
      if (seg === '.' || seg === '') continue
      if (seg === '..') stack.pop()
      else stack.push(seg)
    }
    const base = stack.join('/')
    return [...files.keys()].find(
      (k) => k === base || k.replace(/\.(tsx|ts|jsx|js|vue)$/, '') === base
    )
  }

  for (const [path, body] of files) {
    if (!/\.(tsx|ts|jsx|js)$/.test(path)) continue
    let next = out.get(path) ?? body
    let touched = false

    for (const m of body.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])(\.[^'"]+)\2\s*;?/g)) {
      const [whole, local, quote, spec] = m
      const target = resolve(path, spec)
      if (!target) continue
      const t = files.get(target) ?? ''
      if (/export\s+default\b/.test(t)) continue

      const named = [
        ...t.matchAll(/export\s+(?:const|let|var|function|class)\s+([A-Z][\w$]*)/g),
      ].map((x) => x[1])
      const unique = [...new Set(named)]
      /*
       * The importer's own name, when the target exports it, is not a guess.
       *
       * The one-export rule skipped the commonest shape a repair writes: a
       * shared layout file holding several components, imported by the one it
       * is named after —
       *
       *     // src/components/ui/Screen.tsx
       *     export function Screen …  export function PageTitle …  export function Button …
       *     // src/screens/SettingsScreen.tsx
       *     import Screen from '../components/ui/Screen.js';
       *
       * Measured 2026-09-14: 4 of the 5 repair candidates rejected for breaking
       * the app between the baseline and the comparison runs were exactly this
       * (`Screen` x3 across 13 screens, `Card` beside `CardHeader` and
       * `CardBody` once), each a React #130 on every screen importing it, and
       * each discarding the pass's decomposition, icons and imagery with it.
       */
      const exported = unique.includes(local) ? local : unique.length === 1 ? unique[0] : undefined
      if (!exported) continue
      const clause = exported === local ? `{ ${local} }` : `{ ${exported} as ${local} }`
      next = next.replace(whole, () => `import ${clause} from ${quote}${spec}${quote};`)
      touched = true
      fixed.push(`${local} ← ${target}`)
    }

    if (touched) out.set(path, next)
  }

  return {
    files: out,
    fixed: fixed.length
      ? [
          `default import を名前付き import に修正（対象に default export がなく undefined が描画されます）: ${[
            ...new Set(fixed),
          ]
            .slice(0, 5)
            .join(', ')}`,
        ]
      : [],
  }
}

/**
 * An arrow function cast without being wrapped first.
 *
 *     window.addEventListener('inquiry-confirmed', (e) => {
 *       …
 *     } as EventListener)
 *
 *     [vue/compiler-sfc] Unexpected token, expected "," (34:4)
 *
 * TypeScript will not take an arrow function as the left operand of `as` — the
 * parentheses have to be there:
 *
 *     }) as EventListener)
 *
 * Verified against the transformer rather than assumed: the bare form fails,
 * the parenthesised form and the ordinary `handler as EventListener` both pass.
 * Measured at v186, where one occurrence took a whole Vue project down.
 *
 * Only when the brace really closes an arrow's body. A `}` followed by `as` can
 * also end an object literal or a block, and neither wants parentheses.
 */
export function fixArrowFunctionCast(source: string): { source: string; fixed: string[] } {
  let out = source
  let count = 0

  for (let guard = 0; guard < 12; guard++) {
    let done = true
    for (const m of [...out.matchAll(/\}\s*as\s+[A-Za-z_$][\w$.<>[\]]*/g)]) {
      const closeAt = m.index ?? 0

      // The brace this one closes.
      let depth = 0
      let openAt = -1
      for (let i = closeAt; i >= 0; i--) {
        if (out[i] === '}') depth++
        else if (out[i] === '{') {
          depth--
          if (depth === 0) { openAt = i; break }
        }
      }
      if (openAt < 0) continue

      // An arrow's body, not an object literal or a plain block.
      const before = out.slice(0, openAt).replace(/\s+$/, '')
      if (!before.endsWith('=>')) continue

      // Back over the parameter list to where the arrow starts.
      let start = before.length - 2
      while (start > 0 && /\s/.test(out[start - 1])) start--
      if (out[start - 1] === ')') {
        let d = 0
        let i = start - 1
        for (; i >= 0; i--) {
          if (out[i] === ')') d++
          else if (out[i] === '(') {
            d--
            if (d === 0) break
          }
        }
        if (i < 0) continue
        start = i
      } else {
        let i = start - 1
        while (i >= 0 && /[\w$]/.test(out[i])) i--
        start = i + 1
      }
      const async = /\basync\s*$/.exec(out.slice(0, start))
      if (async) start -= async[0].length

      out = `${out.slice(0, start)}(${out.slice(start, closeAt + 1)})${out.slice(closeAt + 1)}`
      count++
      done = false
      break
    }
    if (done) break
  }

  return {
    source: out,
    fixed: count
      ? [`アロー関数の as キャストを括弧で囲みました（囲まないと TypeScript として構文エラーになります）: ${count}件`]
      : [],
  }
}

