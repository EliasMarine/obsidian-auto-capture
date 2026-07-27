# Contributing

Thanks for taking a look. Issues and pull requests are both welcome.

## Getting set up

Node 22 or newer.

```bash
npm install
npm start     # http://127.0.0.1:4571
npm test
```

There is no build step and no framework. `public/index.html` is one file containing the
markup, styles, and a module script — edit it and reload.

## How the pieces fit

| File | Responsibility |
|---|---|
| `server.js` | HTTP routes, server-sent events, job state |
| `discover.js` | Finding pages: sitemaps, link crawl, path scoping |
| `capture.js` | Fetch, extract, write notes, capture modes |
| `wikilinks.js` | Rewriting links between captured notes |
| `render.js` | Headless-browser fallback for JavaScript pages |
| `fetcher.js` | HTTP, retries, rate limiting, `robots.txt` |
| `paths.js` | URL → file path, sanitising, the write guard |

Each is small on purpose. If one starts doing two jobs, that's a sign to split it.

## Pull requests

- **Add a test for anything non-obvious.** `npm test` uses the built-in `node:test` runner —
  no framework. Look at `test.js` for the style: each test names the behaviour it protects,
  and several exist because a real bug got through once.
- **Keep the dependency count low.** Three runtime dependencies today. A new one needs to earn
  its place against a few lines of plain code.
- **Match the surrounding style.** Comments explain *why*, not *what*.
- Run `npm test` before opening the PR. CI runs the same thing plus a Docker build.

## Things that are deliberate

Worth knowing before proposing a change:

- **The destination must be inside a real vault.** The app walks up from the destination
  looking for `.obsidian` and refuses to write anywhere else. `resolveInside()` in `paths.js`
  additionally blocks any path escaping the destination. Please don't loosen either.
- **Rendering escalates, it isn't a mode.** A browser launches only when extraction comes back
  empty, so ordinary sites never pay for it. There's intentionally no toggle to get wrong.
- **Crawling is polite by default.** `robots.txt` is respected and requests are rate-limited
  per host. Changes that remove or weaken this won't be merged.
- **Images are never downloaded.** The toggle controls whether remote image *markup* survives.

## Reporting a bug

Include the URL you pointed it at, if it's public. Most bugs in this project have turned out
to be site-shape problems — an unusual sitemap, a JavaScript-rendered page, a site putting its
own name in `og:title` on every page — and having the URL makes them reproducible in seconds.

## Security

Found something exploitable? Please open a
[private security advisory](https://github.com/EliasMarine/obsidian-auto-capture/security/advisories/new)
rather than a public issue.
