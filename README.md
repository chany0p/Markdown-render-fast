# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/chany0p/Markdown-render-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/chany0p/Markdown-render-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that produces HTML byte-identical
to marked 18.1.3 (default options: GFM on, breaks off). Implements
CommonMark 0.31.2 plus GFM tables, task lists, strikethrough, and extended
autolinks, including marked's exact quirks.

## Layout

- `parse.js` — the renderer: `export function parse(markdown)`.
- `main.ts` — driver: reads `$MAKEFUN_INPUT_DIR/cases.json` (default
  `/input`), writes `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).

## Test

```sh
node --check parse.js
node main.ts
```
