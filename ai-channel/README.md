# AI Channel by LLPA (design preview)

Static site, no build step. Open `index.html` through any static server, for example:

```bash
npx serve ai-channel
```

- `index.html`: the whole single-page site (hash routes such as `#/explore`, `#/training`, `#/advisory`). It has a design switcher at the bottom: A Journey (default), B Editorial, C Field, Current.
- `t/`: the 35 tools, articles and checklists. Each is a self-contained HTML page, opened inside the site at `#/open/<slug>`.
- `tfig/`: preview screenshots of the tools used on the homepage and topic pages.
- `img/`, `dimg/`: photos.
- `config.js`: integration settings. Fill in before launch: training catalog embed URL, advisory form endpoint, contact email, privacy/terms/cookie links. Until then the site shows "Not connected yet" rather than pretending to work.

`context-windows` is listed as Coming soon and has no page yet.
