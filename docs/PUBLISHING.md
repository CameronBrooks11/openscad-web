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
| `targets[].surface`      | One of `viewer`, `customizer`, or `editor`.                                                |
| `targets[].controls`     | Optional default for embed/customizer controls.                                            |
| `targets[].download`     | Optional default for download UI.                                                          |
| `targets[].title`        | Optional page title.                                                                       |
| `targets[].parentOrigin` | Optional embed security setting for trusted iframe parents.                                |

Important v1 limits:

- only the first `targets[]` entry is assembled
- if you need multiple published targets, that is deferred to a later phase
- `projectRoot` is the publish boundary; files outside it are not copied into the site
- each assembled target carries its own runtime copy in v1

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
