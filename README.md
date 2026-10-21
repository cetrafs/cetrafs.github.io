# cetrafs-website

Source for the cetrafs documentation site, built with [Hugo](https://gohugo.io)
and a custom in-repo theme (`themes/cetrafs/`). No Node, no build step beyond Hugo.

## Prerequisites

- Hugo **extended** v0.158 or newer (the config uses `locale`). CI pins 0.168.0.

## Run locally

```bash
hugo server -D        # http://localhost:1313/
```

## Build

```bash
hugo --minify         # output in public/ (git-ignored)
```

## Structure

Content follows the [Diátaxis](https://diataxis.fr/) framework:

```
content/
  _index.md                 # homepage (layout: themes/cetrafs/layouts/index.html)
  docs/
    _index.md               # /docs/ landing page
    intro/        (w=5)     # what cetrafs is, project status
    tutorials/    (w=200)   # learning-oriented: loop device -> two nodes -> Proxmox
    how-tos/      (w=300)   # task-oriented recipes
    concepts/     (w=400)   # understanding-oriented explanation
    reference/    (w=500)   # tools, mount options, procfs, params, limits, format
themes/cetrafs/
  layouts/                  # baseof, single/list (shared partials/doc-page.html), home, 404
  layouts/partials/         # topbar, sidebar, toc, breadcrumbs, doc-kind badge, prev/next, brand mark
  layouts/shortcodes/       # callout, steps, version
  assets/css/main.css       # the whole design system (CSS custom properties, light/dark)
  assets/js/                # client-side search, copy-code button
  static/                   # fonts, favicons, logo SVG, social card
```

A page's Diátaxis badge (Tutorial / How-to / Explanation / Reference) is derived
from its top-level section automatically.

## Writing a page

```yaml
---
title: "Page title"
description: "One line, used in search results, section cards and SEO."
weight: 345          # order within the section; check siblings
toc: true
---
```

Shortcodes:

```
{{< callout type="note|tip|warning|danger" title="Optional" >}}Markdown{{< /callout >}}
{{< steps >}}1. numbered steps rendered as badges{{< /steps >}}
{{< version >}}   the current release, from params.version in hugo.toml
```

Never hardcode the release number in content: use `{{< version >}}` (it also
works inside code blocks). Templates use `.Site.Params.version`.

The search index (`/index.json`) and section cards are generated automatically.

### Keeping docs accurate

The content is derived from the cetrafs source tree (`docs/*.md`, `include/cetrafs.h`,
`kmod/procfs.c`, the tools' usage text). When those disagree, **the code wins**.
Things worth re-checking on each release: the version in `hugo.toml`
(`params.version`), supported kernels, procfs fields, module parameters, and
mkfs defaults.

## Brand

The logo is redrawn as SVG (`themes/cetrafs/static/logo/cetrafs-mark.svg`,
inlined via `partials/brand-mark.html`) from `cetrafs-logo.png` in the source
repo. Brand navy is `#032D7B`.

## Deployment

The site is published at <https://cetrafs.com/> (`baseURL` in `hugo.toml`).

`.gitlab-ci.yml` builds it and deploys it to GitLab Pages. Publishing is
**manual**: on the default branch the `pages` job waits for someone to press
"Run" in the pipeline view. Other branches only build. The custom domain and its
TLS certificate are configured in GitLab under *Deploy > Pages*, not in this repo.

The pipeline clones with full history (`GIT_DEPTH: 0`) because each page's
"last updated" date comes from git (`enableGitInfo`).

`.github/workflows/deploy.yml` does the same for GitHub Pages, in case the site
is mirrored there.

## License

Documentation (`content/`): CC BY 4.0. Website code: MIT (`LICENSE`). Fonts:
SIL OFL 1.1. Details in [`LICENSE-docs.md`](LICENSE-docs.md). cetrafs itself is
GPL-2.0-or-later.
