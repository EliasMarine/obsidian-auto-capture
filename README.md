# Obsidian auto-capture

[![CI](https://github.com/EliasMarine/obsidian-auto-capture/actions/workflows/ci.yml/badge.svg)](https://github.com/EliasMarine/obsidian-auto-capture/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Crawl an entire website and save the pages into an [Obsidian](https://obsidian.md) vault as
Markdown — with links between the captured pages rewritten as `[[wikilinks]]`, so the result
is a connected set of notes instead of a folder of orphans.

It uses [`defuddle`](https://github.com/kepano/defuddle), the same extraction engine as the
official Obsidian Web Clipper, so notes come out with the clipper's frontmatter and Markdown
(including Obsidian-style callouts). No browser extension involved.

![Review pages](screenshots/02-review.png)

## Why

The Web Clipper is excellent for one page at a time. It can't do a whole documentation site,
because it hands each clip to Obsidian through the `obsidian://` URL scheme — one page, one
handoff. This is the bulk version: point it at a docs site, pick what you want from a tree,
and get the lot.

## What it does

- **Finds pages** via `sitemap.xml`, falling back to a same-origin link crawl.
- **Scopes the crawl** to a path, so `/docs/guides/` doesn't drag in 3,000 unrelated pages.
- **Lets you choose** — a folder tree with checkboxes, an exclude filter, and sensible defaults
  (`/tag/`, `/author/`, `/page/2` and query-string URLs start unticked).
- **Extracts article text**, dropping navigation, ads and boilerplate.
- **Falls back to a real browser** when a page turns out to be a JavaScript shell.
- **Links the notes together** so Obsidian's graph and backlinks work — including
  `#section` links, which land on the right heading instead of the top of the page.
- **Builds a map note** per site, ranking hubs by inbound links and flagging orphans.
- **Tells you what the site changed** on a re-crawl, as a dated changelog note.
- **Knows what it already has**, so re-runs skip, update, or overwrite as you choose.

## Install

Requires Node 22+.

```bash
git clone https://github.com/EliasMarine/obsidian-auto-capture.git
cd obsidian-auto-capture
npm install
npm start
```

Open <http://127.0.0.1:4571>. The server binds to localhost only.

### Docker

Use the published image:

```bash
curl -O https://raw.githubusercontent.com/EliasMarine/obsidian-auto-capture/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/EliasMarine/obsidian-auto-capture/main/.env.example
# edit .env to point OBSIDIAN_VAULT at your vault, then:
docker compose up -d
```

Images are published to `ghcr.io/eliasmarine/obsidian-auto-capture` for `linux/amd64`
and `linux/arm64`.

To upgrade, both steps are required:

```bash
docker compose pull
docker compose up -d --force-recreate
```

`--force-recreate` is not optional. Compose decides whether to replace a container by
comparing its config, and `image: …:latest` is the same string before and after a pull —
so a plain `up -d` reports `Running` and leaves the old image in place. Same reason
`docker compose restart` won't pick up an edited `.env`: it restarts the process, it
doesn't re-read `env_file`. Use `up -d --force-recreate` after changing `OBSIDIAN_VAULT` too.

Or build it yourself from a clone:

```bash
cp .env.example .env      # point OBSIDIAN_VAULT at your vault folder
docker compose up -d --build
```

Same URL. The published port is bound to `127.0.0.1`, so it isn't exposed to your network.
The vault root is mounted at `/vault`, so the destination inside the container is `/vault/raw`.

## Using it

![Set up](screenshots/01-setup.png)

1. **Set up** — a start URL, a path to stay within, and a destination folder inside your vault.
   The destination must sit inside a folder containing `.obsidian`; the app refuses to write
   anywhere else.
2. **Review pages** — everything found, as a collapsible tree. Tick what you want.
3. **Capture** — writes the notes, then rewrites the links between them.

There's also a **Just one page** box that skips discovery entirely.

![Capture](screenshots/03-capture.png)

## Where notes land

Every site gets its own folder, so one capture never spills into another:

```
raw/
└── pve.proxmox.com/          ← hostname, www. stripped
    └── pve-docs/             ← mirrors the URL path
        ├── Introduction.md
        └── Frequently Asked Questions.md
```

Filenames come from the page title, falling back to the URL slug when a site puts its own
name in `og:title` on every page.

## Linked notes

After a capture, links *between* captured pages become Obsidian `[[wikilinks]]`. The pass runs
over the whole set rather than per page, so a note linking forward to a page captured later
still resolves. Links to pages you didn't capture, and anything inside a code fence, are left
exactly as they were. Turn it off with the **Link notes to each other** toggle.

**Section links survive.** A link to `…/firewall#_firewall_rules` becomes
`[[Firewall#Firewall Rules]]`, not a jump to the top of a 3,000-word page. The URL fragment is
an HTML id, so heading ids are recorded at capture time and mapped back to heading text. A
fragment that doesn't name a heading falls back to linking the note as a whole.

## The map note

Each site folder gets a `_map.md`: pages ranked by how many other captured pages link to them,
so the site's own hubs rise to the top, and an **Orphans** section for pages nothing points at
— usually entry points, or pages only the site navigation reached. It's the way into a few
hundred imported notes. Turn it off with **Build a map note**.

If a captured page has already claimed the name `_map`, the generated one steps aside rather
than overwriting it.

## What changed since last time

With **Log what changed** on, a re-crawl writes `_changelog/YYYY-MM-DD.md` listing the pages
the *source site* edited, with a short excerpt of the lines added and removed, and links to
the notes themselves. Pages captured for the first time are listed separately under
**New pages**.

This is what makes a capture worth repeating: point it at an API reference, a pricing page, or
a vendor's terms, re-run it weekly, and the vault tells you what moved. Nothing changed means
no note is written, so a quiet week leaves no litter. A second crawl on the same day appends a
section rather than replacing the day's record.

Comparison ignores link syntax, so a link the wikilink pass rewrote doesn't read as an edit.
The trade-off: a link whose target changed but whose visible text didn't goes unreported.

## Re-running

`.crawl-index.json` in the destination folder maps each URL to its note and a hash of the
extracted content. **Pages I already have** controls what happens next time:

| Mode | Behaviour |
|---|---|
| Skip them | Existing notes are never touched (default) |
| Update if changed | Re-fetches, rewrites only pages whose content actually changed |
| Overwrite always | Rewrites everything, discarding local edits |

## JavaScript-rendered sites

Some sites send an empty shell and build the page in the browser. When extraction comes back
empty, the page is re-fetched through a headless browser and extracted again. Pages that work
over plain HTTP never launch a browser, so you only pay for it where it's needed.

This drives whatever Chrome, Edge or Chromium is already installed (via `playwright-core`)
rather than downloading its own. Set `OAC_NO_RENDER=1` to disable it entirely.

## Being a good citizen

`robots.txt` is respected, requests are rate-limited per host, and the page limit stops a
runaway crawl. Only crawl sites you're allowed to.

## Pages behind a login

Set `OAC_CHROME_PROFILE` to a Chrome profile directory and rendering reuses that profile's
session, so internal wikis and subscription docs capture as the logged-in you. No extension,
no credentials handed to this tool — it borrows a session your browser already has.

```bash
# copy the profile first; see the warnings below
cp -R "$HOME/Library/Application Support/Google/Chrome/Default" /tmp/oac-profile
OAC_CHROME_PROFILE=/tmp/oac-profile npm start
```

Read this before using it:

- **Point it at a copy, not your live profile.** Chromium takes an exclusive lock on a profile
  directory, so Chrome must be fully quit — and a crawl writing to your real profile is not
  something you want to debug.
- **Every cookie in that profile is sent to whatever the crawl reaches.** Scope the crawl
  tightly. Don't combine this with a start URL you haven't vetted.
- **Docker can't do this.** The container is Linux with no host Chrome — the same constraint
  that put Chromium in the image.

Without this variable nothing changes: each page renders in a fresh, cookie-free context.

## Limits

- **Images are never downloaded.** With the toggle on you get remote `![](…)` links; off strips
  the markup entirely.
- **One job at a time** — it's a single-user local tool.
- **Change detection is line-level, not positional.** Moving a paragraph without editing it
  reads as unchanged.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default `4571`) |
| `OAC_HOST` | Bind address (default `127.0.0.1`; the image sets `0.0.0.0`) |
| `OAC_CONFIG` | Path to the settings file |
| `OAC_DEFAULT_DEST` | Destination used when no setting is saved yet |
| `OAC_BROWSER_PATH` | Explicit browser executable for rendering |
| `OAC_NO_RENDER` | Set to `1` to disable headless rendering |
| `OAC_CHROME_PROFILE` | Chrome profile directory to reuse for logged-in pages (see above) |

## Tests

```bash
npm test
```

Covers URL→path mapping, filename sanitising, the write-outside-destination guard, YAML
escaping, scope narrowing, the link-list heuristic, wikilink rewriting, heading-anchor
extraction, section links, the inbound link graph, change detection, and map generation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## License

[MIT](LICENSE)
