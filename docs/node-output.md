# Readable node output

Open a node's **More** button, then **Output**, to read its captured output. The modal retains exactly three content tabs: **Output**, **Changes**, and **Context**. Any pending user decision appears before the output. Selecting a compact canvas node still only binds the bottom composer.

Output opens in **Preview**, with headings, lists, fenced code, and GFM tables. **Raw text** shows captured text without Markdown interpretation. **Copy** writes that same exact text through `navigator.clipboard.writeText`; success appears only after the promise resolves. Clipboard failure or unavailability leaves Raw text selectable. A node/run change resets view and copy state; new output invalidates pending copy feedback without moving toolbar focus. An already-started native clipboard write cannot be cancelled.

Running, retrying, and failed notices accompany captured output instead of replacing it. Empty text disables Copy. Whitespace-only text is captured output and remains copyable; Preview explains how to inspect it in Raw text.

## Preserve the stream

Use `node.output.join("")`. Entries are ordered payload fragments, not guaranteed lines. Do not insert separators, trim, normalize line endings or tabs, remove blank lines, deduplicate, or substitute summaries. A word or fence may span several entries. Markdown parsing changes presentation only; Raw and Copy always use the exact joined string.

Verified against this checkout:

- `packages/project-core/src/index.ts:3225` declares `CanvasNode.output: string[]`.
- `packages/ui-canvas/src/workflowRuntime.ts:1203` maps output payload text unchanged. Its final `filter(Boolean)` drops empty strings only; it establishes no line boundary.
- `packages/workflow-kernel/src/index.ts:4412` appends text without a separator. Tests in `src/index.test.ts:2695` and `:2764` retain empty and whitespace-bearing typed deltas.
- `packages/persistence/src/workflowStore.test.ts:8896` verifies reopened output `["  planner output\n", "\tplanner progress  \n"]`, with compact summaries excluded from output.

## Rendering and integration boundaries

Preview uses installed `react-markdown` and `remark-gfm`, with raw HTML skipped and no raw-HTML plugin. Markdown images become alt-text spans, so no image element or React image preload can fetch remote content. Only absolute HTTP(S) links without credentials are clickable; other destinations retain their labels as text. Web links open separately with `noopener noreferrer`. Raw text displays HTML as text. See the [react-markdown security and component API](https://github.com/remarkjs/react-markdown#security).

App renders the decision panel before `ResultOutput`, without the old `.output-lines` ancestor whose paragraph rules would affect nested Markdown. `ResultOutput` is keyed by node ID and run ID, never by output text, so streaming updates preserve mode and focus. The exported `src/styles.css` entry imports `ResultOutput.css`; package `tsc` does not copy CSS into `dist`, so the compiled component does not import CSS.

Focused tests exercise actual React static rendering, split words/fences, exact whitespace, hostile Markdown, lifecycle notices, and injectable clipboard success/failure/unavailability and stale completion. App regression tests render the real `OutputTab` and `NodeModal`, covering decision ordering, readable split output, safe links/images, and exactly three content tabs. Interactive theme/layout and focus checks, native Electron clipboard, and real Electron workflow acceptance remain parent-owned validation.
