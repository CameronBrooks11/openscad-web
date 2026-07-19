# Publishing OpenSCAD Projects

This repo ships two publishing pieces:

- a relocatable publish artifact: `openscad-web-publish.zip`
- a GitHub Action wrapper: `uses: CameronBrooks11/openscad-web@v0`

The action assembles a static site tree from your OpenSCAD project and then hands that tree back to your workflow. You still use the standard GitHub Pages upload and deploy actions yourself.

## Mental Model

Think in terms of four questions:

1. What is the entry file?
2. What other files does that entry file need beside it?
3. What kind of page do you want to publish?
4. Where should that page live inside the final site?

For OpenSCAD projects, the normal unit is a project tree, not just a single file. In v1:

- `projectRoot + entry` is the canonical publish shape
- `source` is the shorthand for a truly standalone `.scad` file
- `mountPath` is relative to the published site root
- do not include the repository slug in `mountPath`

Examples:

- repo Pages site, model under `https://user.github.io/repo/model/` -> `mountPath: /model/`
- user site, model under `https://user.github.io/model/` -> `mountPath: /model/`
- publish the model at the site root -> `mountPath: /`

The host adds its own outer URL prefix. Your publish config only describes the site tree you are assembling.

## Quick Start

Single-file viewer:

```yaml
name: Publish OpenSCAD

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6

      - uses: actions/configure-pages@v5

      - name: Assemble site
        id: assemble
        uses: CameronBrooks11/openscad-web@v0
        with:
          source: ./models/widget.scad
          surface: viewer
          mount-path: /model/

      - uses: actions/upload-pages-artifact@v4
        with:
          path: ${{ steps.assemble.outputs.site-dir }}

  deploy:
    runs-on: ubuntu-24.04
    needs: build
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

## Config File

Use `openscad-publish.yml` when you want a repeatable publish definition or a multi-file project:

```yaml
site:
  outDir: ./site

targets:
  - projectRoot: ./models/assembly
    entry: ./main.scad
    mountPath: /assembly/
    surface: customizer
    controls: true
    download: true
    title: Assembly Configurator
```

Then call the action with:

```yaml
- name: Assemble site
  id: assemble
  uses: CameronBrooks11/openscad-web@v0
  with:
    config: ./openscad-publish.yml
```

Field reference:

| Field                    | Meaning                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `site.outDir`            | Final output directory. Resolved relative to the config file.                              |
| `targets[].source`       | Single-file shorthand.                                                                     |
| `targets[].projectRoot`  | Publish boundary for a multi-file project. Everything under this directory becomes public. |
| `targets[].entry`        | Entry `.scad` file inside `projectRoot`. Resolved relative to `projectRoot`.               |
| `targets[].mountPath`    | Mount path inside the final site tree, such as `/` or `/model/`.                           |
| `targets[].surface`      | One of `viewer`, `customizer`, `editor`, or `static`.                                      |
| `targets[].geometry`     | **`static` only.** Path to a pre-rendered OFF geometry file (see below).                   |
| `targets[].poster`       | **`static` only.** Optional path to a pre-rendered PNG poster.                             |
| `targets[].controls`     | Optional default for embed/customizer controls.                                            |
| `targets[].download`     | Optional default for download UI.                                                          |
| `targets[].title`        | Optional page title.                                                                       |
| `targets[].parentOrigin` | Optional embed security setting for trusted iframe parents.                                |

## Static (Pre-Rendered) Surface

The `viewer`/`customizer`/`editor` surfaces run the OpenSCAD **WASM compiler in
the browser** (~13 MB) so the model is live. The `static` surface instead ships
a **pre-rendered** model to a lightweight read-only viewer (~0.6 MB, no WASM) —
ideal for docs pages that only need to _show_ a model.

Render the geometry (and an optional poster) with the OpenSCAD **CLI** — the
bundled helper does both:

```bash
node scripts/render-geometry.mjs --source ./models/widget.scad --out-dir ./rendered
# -> ./rendered/widget.off  (geometry the viewer displays)
#    ./rendered/widget.png  (poster; add --no-poster to skip)
```

(Equivalent by hand: `openscad -o widget.off widget.scad` and
`openscad -o widget.png --viewall --autocenter --render widget.scad`.)

Then publish the pre-rendered files with `surface: static`:

```yaml
targets:
  - surface: static
    geometry: ./rendered/widget.off
    poster: ./rendered/widget.png
    mountPath: /widget/
    title: Widget
```

The mount holds `geometry.off`, `poster.png`, a boot config, and the static
viewer page — no compiler, no `.scad`. The OpenSCAD CLI must be available where
you run the render step (it is not part of `deploy-configure`, which stays
dependency-free); GitHub's `ubuntu-*` runners can `apt-get install -y openscad`.

Multiple targets:

- every `targets[]` entry is assembled, each into its own `mountPath`
- mount paths must be unique and non-overlapping — one mount path may not be
  nested inside another, and `mountPath: /` (site root) may only be used when it
  is the single target
- `projectRoot` is the publish boundary; files outside it are not copied into the site

### Runtime sharing

- **A single target is self-contained.** Its mount holds the whole runtime plus
  its project and boot config — the mount directory is complete on its own.
- **Multiple targets share one runtime.** The runtime is assembled once into
  `<site>/_openscad-web/<artifact-version>/`, and each target's mount is thin: a
  rewritten `index.html` pointing at the shared runtime, plus its own `project/`
  and `openscad-web.config.json`. So a site with N models is roughly
  `runtime + N × (small project payload)` instead of N runtime copies.
- The shared runtime path is versioned, so publishing with a new artifact
  version adds a new runtime alongside the old one rather than replacing it.
- `/_openscad-web/` is reserved; a `mountPath` may not live under it.
- Shared-runtime paths are **relative**, so the site works under any base URL
  (repo Pages subpath, user site, or a custom domain) with no configuration.
- If you serve the assembled tree by feeding it **back through a Jekyll build**
  (rather than uploading it as a static Pages artifact, the normal path), add a
  `.nojekyll` file so the underscore-prefixed `_openscad-web/` directory is not
  stripped.

### Re-runs and recovery

- **Re-running is safe.** Each mount is stamped with an ownership marker; a later
  run detects its own mounts and replaces them in place, leaving sibling and
  unrelated content untouched. Assembly refuses to overwrite a non-empty
  directory it does not own.
- **A renamed or removed target orphans its old mount.** Assembly only creates
  or replaces the mounts named in the current config; it does not delete a mount
  you published previously and then dropped. If you rename or remove a target,
  clear its old mount directory yourself.
- **After a failed assembly, clear the output directory before retrying.** If a
  run fails partway through a multi-target assembly, a partially written mount
  may be left without its ownership marker, and the next run will refuse to
  overwrite it. Remove the output directory (or the offending mount) and re-run.

## Mixed-Site Example

If your repo already builds other static content at the root and you want OpenSCAD under `/model/`, assemble into the same output directory:

```yaml
- name: Build docs site
  run: bundle exec jekyll build --destination ./site

- name: Assemble OpenSCAD target
  id: assemble
  uses: CameronBrooks11/openscad-web@v0
  with:
    config: ./openscad-publish.yml
    output-dir: ./site
```

With config:

```yaml
targets:
  - projectRoot: ./models/assembly
    entry: ./main.scad
    mountPath: /model/
    surface: viewer
```

The assembly tool only replaces the mount directory it owns. It will refuse to overwrite unrelated existing content.

## Direct Script Use

The GitHub Action is just a wrapper around the host-neutral assembly script:

- [scripts/deploy-configure.mjs](../scripts/deploy-configure.mjs)

Today the supported turnkey path is GitHub Actions. If you want to use another CI system, the core assembly logic already lives in that script. That keeps GitHub-specific behavior at the edge instead of in the publish model itself.

## Security Notes

If you are publishing `viewer` pages for iframe embedding:

- follow [docs/EMBED.md](./EMBED.md) for the postMessage contract
- follow [docs/SECURITY.md](./SECURITY.md) for embed trust-boundary guidance
- set `parentOrigin` only when you want to restrict which parent page may talk to the embed

## Related Docs

- [docs/DEPLOYMENT.md](./DEPLOYMENT.md)
- [docs/EMBED.md](./EMBED.md)
- [docs/SECURITY.md](./SECURITY.md)
