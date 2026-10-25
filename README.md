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
  layouts/shortcodes/       # callout, steps, version, plugin-version
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
{{< version >}}          the current cetrafs release, from params.version in hugo.toml
{{< plugin-version >}}   the current cetrafs-proxmox release, from params.pluginVersion
```

Never hardcode a release number in content: use `{{< version >}}` or
`{{< plugin-version >}}` (both work inside code blocks). Templates use
`.Site.Params.version` and `.Site.Params.pluginVersion`.

The search index (`/index.json`) and section cards are generated automatically.

### Keeping docs accurate

The content is derived from the cetrafs source tree (`docs/*.md`, `include/cetrafs.h`,
`kmod/procfs.c`, the tools' usage text). When those disagree, **the code wins**.
Things worth re-checking on each release: the versions in `hugo.toml`
(`params.version` for cetrafs, `params.pluginVersion` for cetrafs-proxmox), supported kernels, procfs fields, module parameters, and
mkfs defaults.

## Brand

The logo is redrawn as SVG (`themes/cetrafs/static/logo/cetrafs-mark.svg`,
inlined via `partials/brand-mark.html`) from `cetrafs-logo.png` in the source
repo. Brand navy is `#032D7B`.

## Deployment

The site is published at <https://cetrafs.com/> (`baseURL` in `hugo.toml`).

The repository has two remotes, kept in sync: `origin` (GitLab) and `gh`
(GitHub, `cetrafs/cetrafs.github.io`). **A push to `gh/main` publishes the
site**: `.github/workflows/deploy.yml` builds it and deploys it to GitHub Pages.
The custom domain is set in the GitHub repository's Pages settings (`CNAME`).
On GitLab, `.gitlab-ci.yml` only checks that the site builds.

Both pipelines clone with full history, because each page's "last updated" date
comes from git (`enableGitInfo`).

## License

Documentation (`content/`): CC BY 4.0. Website code: MIT (`LICENSE`). Fonts:
SIL OFL 1.1. Details in [`LICENSE-docs.md`](LICENSE-docs.md). cetrafs itself:
kernel module GPL-2.0-or-later, tools AGPL-3.0-or-later or commercial.
