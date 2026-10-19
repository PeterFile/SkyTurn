# Readable node output

Open a node's **More** button, then **Output**, to read its captured output. The modal retains exactly three content tabs: **Output**, **Changes**, and **Context**. Any pending user decision appears before the output. Selecting a compact canvas node still only binds the bottom composer.

Output opens in **Preview**, with headings, lists, fenced code, and GFM tables. **Raw text** shows captured text without Markdown interpretation. **Copy** writes that same exact text through `navigator.clipboard.writeText`; success appears only after the promise resolves. Clipboard failure or unavailability leaves Raw text selectable. A node/run change resets view and copy state; new output invalidates pending copy feedback without moving toolbar focus. An already-started native clipboard write cannot be cancelled.

Running, retrying, and failed notices accompany captured output instead of replacing it. Empty text disables Copy. Whitespace-only text is captured output and remains copyable; Preview explains how to inspect it in Raw text.

## Find captured text

Select **Find** to open **Raw text** and focus the search input. Find searches the exact captured string, not the Markdown display. Matching is case-sensitive, literal, and non-overlapping: punctuation such as `.*` has no special meaning, and spaces are part of the query. An empty query prompts for text; a query with no results shows **No matches** and disables navigation.

Use **Previous** and **Next** to navigate with wrapping. While the Find input has focus, **Enter** moves forward, **Shift+Enter** moves backward, and **Escape** closes Find and returns focus to its button. **Clear** empties the query and keeps the input focused. **Close** clears and closes Find while keeping Raw text open. **Preview** closes Find and returns to Markdown. These keys have no global binding and do not take over the composer.

The count shows the active result and total. Find retains at most the first 1000 match positions. If more exist, it explicitly says **capped; first 1000 only**, and navigation wraps within those retained results. Only the active match receives presentation markup and scrolls into view; Raw output's `textContent` and **Copy** still contain the exact captured string, including whitespace, CRLF, and split fragments. Search never interprets captured HTML or loads remote content.

Streaming updates preserve the query, input focus, and active result index. If results shrink, the index clamps to the remaining range. Editing the query starts at the first result. Switching node or run clears Find along with the existing view and copy state. Search is memoized by captured text, query, and open state, so navigation, copy feedback, and unrelated status renders do not rescan unchanged output.

## Preserve the stream

Use `node.output.join("")`. Entries are ordered payload fragments, not guaranteed lines. Do not insert separators, trim, normalize line endings or tabs, remove blank lines, deduplicate, or substitute summaries. A word or fence may span several entries. Markdown parsing changes presentation only; Raw and Copy always use the exact joined string.

Captured display text includes the top-level string `payload.text` of strictly parsed `output`, `progress`, and `changes` RunEvent deltas. Renderer observability and local projection preserve those fragments in event order, including empty strings, whitespace, and public CLI warnings, across streaming updates and replay. Status, error, evidence, and approval metadata, nested text, patches, commands, and compact summaries do not become captured output.

Hermes `WorkflowIntent` and workflow-card tool parsing use only `output` events, with their existing protocol fragment handling. Diagnostic `progress` or `changes` JSON is display text and cannot create or alter workflow topology or policy. Completion still depends on canonical `RunEvidence`.

Verified against this checkout:

- [Project core](../packages/project-core/src/index.ts) declares `CanvasNode.output: string[]` and strictly parses public RunEvent deltas.
- [Workflow runtime tests](../packages/ui-canvas/src/workflowRuntime.test.ts) cover exact interleaved display fragments, event ordering and deduplication, renderer-state replay, metadata exclusion, and diagnostic JSON isolation from planner operations.
- [Flow Kernel tests](../packages/workflow-kernel/src/index.test.ts) retain empty and whitespace-bearing typed deltas without adding separators.
- [Persistence tests](../packages/persistence/src/workflowStore.test.ts) cover reopened output `["  planner output\n", "\tplanner progress  \n"]`, with compact summaries excluded from output. Renderer unit replay does not replace SQLite or real Electron acceptance.

## Rendering and integration boundaries

Preview uses installed `react-markdown` and `remark-gfm`, with raw HTML skipped and no raw-HTML plugin. Markdown images become alt-text spans, so no image element or React image preload can fetch remote content. Only absolute HTTP(S) links without credentials are clickable; other destinations retain their labels as text. Web links open separately with `noopener noreferrer`. Raw text displays HTML as text. See the [react-markdown security and component API](https://github.com/remarkjs/react-markdown#security).

App renders the decision panel before `ResultOutput`, without the old `.output-lines` ancestor whose paragraph rules would affect nested Markdown. `ResultOutput` is keyed by node ID and run ID, never by output text, so streaming updates preserve mode and focus. The exported `src/styles.css` entry imports `ResultOutput.css`; package `tsc` does not copy CSS into `dist`, so the compiled component does not import CSS.

Focused tests exercise actual React static rendering, split words/fences, exact whitespace, hostile Markdown, lifecycle notices, and injectable clipboard success/failure/unavailability and stale completion. Find tests cover literal offsets, bounded positions, presentation-only highlighting, exact Copy, scoped keyboard handlers, wrapping, query resets, streaming updates, clamping, and memoization. The interaction tests use the repository's shallow-hook pattern with focus/scroll targets; they do not provide native DOM or Electron acceptance. App regression tests render the real `OutputTab` and `NodeModal`, covering decision ordering, readable split output, safe links/images, and exactly three content tabs. Interactive theme/layout and focus checks, native Raw `textContent` and clipboard, and real Electron workflow acceptance remain parent-owned validation.
