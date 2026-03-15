# OpenSCAD Playground

[Open the Demo](https://ochafik.com/openscad2)

<a href="https://ochafik.com/openscad2" target="_blank">
<img width="694" alt="image" src="https://github.com/user-attachments/assets/58305f27-7e95-4c56-9cd7-0d766e0a21ae" />
</a>

This is a limited port of [OpenSCAD](https://openscad.org) to WebAssembly, using at its core a headless WASM build of OpenSCAD ([done by @DSchroer](https://github.com/DSchroer/openscad-wasm)), wrapped in a Lit-based web component UI with Monaco editor integration and a Three.js viewer.

It defaults to the [Manifold backend](https://github.com/openscad/openscad/pull/4533) so it's **super** fast.

Enjoy!

Licenses: see [LICENSE.md](./LICENSE.md).

## Features

- Automatic preview on edit (F5), and full rendering on Ctrl+Enter (or F6). Using a trick to force $preview=true.
- [Customizer](https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Customizer) support
- Syntax highlighting
- Ships with many standard SCAD libraries (can browse through them in the UI)
- Autocomplete of imports
- Autocomplete of symbols / function calls (pseudo-parses file and its transitive imports)
- Responsive layout. On small screens editor and viewer are stacked onto each other, while on larger screens they can be side-by-side
- Installable as a PWA (persists edits in BrowserFS/IndexedDB instead of the hash fragment). On iOS just open the sharing panel and tap "Add to Home Screen". _Should not_ require any internet connectivity once cached.

## Roadmap

- [x] Add tests!
- [x] Persist camera state
- [x] Support 2D somehow? (e.g. add option in OpenSCAD to output 2D geometry as non-closed polysets, or to auto-extrude by some height)
- [x] Proper Preview rendering: have OpenSCAD export the preview scene to a rich format (e.g. glTF, with some parts being translucent when prefixed w/ % modifier) and display it using https://modelviewer.dev/ maybe)
- ~~Rebuild w/ (and sync) ochafik@'s filtered kernel (https://github.com/openscad/openscad/pull/4160) to fix(ish) 2D operations~~
- [x] Bundle more examples (ask users to contribute)
- Animation rendering (And other formats than STL)
- [x] Compress URL fragment
- [x] Mobile (iOS) editing support: switch to https://www.npmjs.com/package/react-codemirror ?
- [x] Replace Makefile w/ something that reads the libs metadata
- [ ] Merge modifiers rendering code to openscad
- Model /home fs in shared state. have two clear paths: /libraries for builtins, and /home for user data. State pointing to /libraries paths needs not store the data except if there's overrides (flagged as modifications in the file picker)
- Drag and drop of files (SCAD, STL, etc) and Zip archives. For assets, auto insert the corresponding import.
- Fuller PWA support w/ link Sharing, File opening / association to \*.scad files...
- Look into accessibility
- Setup [OPENSCADPATH](https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Libraries#Setting_OPENSCADPATH) env var w/ Emscripten to ensure examples that include assets / import local files will run fine.
- Detect which bundled libraries are included / used in the sources and only download these rather than wait for all of the zips. Means the file explorer would need to be more lazy or have some prebuilt hierarchy.
- Preparse builtin libraries definitions at compile time, ship the JSON.

## Building

The project uses:

- explicit Node build scripts for WASM, font, and library asset preparation, all driven by `libs-config.json`
- Vite for app and worker bundling
- an explicit Workbox build step for `sw.js` generation in production builds

Asset preparation is handled by explicit Node scripts, while Vite bundles the app and worker and Workbox generates the production service worker.

Runtime asset and library delivery policy:

- runtime asset URLs resolve against the current page origin plus the active base path instead of bundler-output-relative paths
- runtime asset URLs resolve through `import.meta.env.BASE_URL` so subpath deploys and local preview paths stay consistent
- the OpenSCAD JS/WASM runtime now flows through the Vite asset graph instead of hand-maintained public runtime files
- BrowserFS is bundled as a runtime dependency in the app and worker instead of being loaded through a hand-maintained public script
- bootstrap prefetch hints come from generated library metadata instead of hardcoded HTML links
- full editor mode eagerly mounts all libraries on the main thread so browsing and completions keep working
- embed/customizer shells and worker compile paths keep using demand-loaded libraries

Prerequisites:

- wget or curl
- Node.js (>=24.0.0)
- npm
- git
- zip
- Docker able to run amd64 containers (only needed if building WASM from source). If running on a different platform (including Silicon Mac), you can add support for amd64 images through QEMU with:

```bash
docker run --privileged --rm tonistiigi/binfmt --install all
```

Local dev:

```bash
npm install
npm run build:libs  # Download WASM and build all OpenSCAD libraries
npm run start
# http://localhost:4000/
```

Local prod (build for a prefixed `/dist/` path and serve the repo root so the app is exercised at `http://localhost:3000/dist/`):

```bash
npm install
npm run build:libs  # Download WASM and build all OpenSCAD libraries
npm run start:production
# http://localhost:3000/dist/
```

## Testing

Run the unit suite:

```bash
npm run test:unit
```

Run the browser E2E suite against the canonical production-style path:

```bash
npx playwright install chromium
npm run build:libs  # if the library/WASM assets are not already prepared
npm run test:e2e
```

Run the browser E2E suite against the Vite dev server for local debugging:

```bash
npx playwright install chromium
npm run build:libs  # if the library/WASM assets are not already prepared
npm run test:e2e:dev
```

Deployment (edit "homepage" in `package.json` to match your deployment root!):

```bash
npm install
npm run build:all  # Build libraries and compile the application

rm -fR ../ochafik.github.io/openscad2 && cp -R dist ../ochafik.github.io/openscad2
# Now commit and push changes, wait for site update and enjoy!
```

## Build your own WASM binary

The build system fetches a prebuilt OpenSCAD web WASM binary, but you can build your own in a couple of minutes:

- **Optional**: use your own openscad fork / branch:

  ```bash
  rm -fR libs/openscad
  ln -s $PWD/../absolute/path/to/your/openscad libs/openscad

  # If you had a native build directory, delete it.
  rm -fR libs/openscad/build
  ```

- Build WASM binary (add `WASM_BUILD=Debug` argument if you'd like to debug any cryptic crashes):

  ```bash
  npm run build:libs:wasm
  ```

- Then continue the build:

  ```bash
  npm run build:libs
  npm run start
  ```

## Adding OpenSCAD libraries

The asset build pipeline reads from `libs-config.json` to manage all library dependencies. You'll need to update 3 files (search for BOSL2 for an example):

- [libs-config.json](./libs-config.json): to add the library's metadata including repository URL, branch, and files to include/exclude in the zip archive

- [src/fs/zip-archives.generated.ts](./src/fs/zip-archives.generated.ts): generated zip metadata consumed by the UI and library mount code

- [LICENSE.md](./LICENSE.md): most libraries require proper disclosure of their usage and of their license. If a license is unique, paste it in full, otherwise, link to one of the standard ones already there.

### Library Configuration Format

In `libs-config.json`, add an entry like this:

```json
{
  "name": "LibraryName",
  "repo": "https://github.com/user/repo.git",
  "branch": "main",
  "zipIncludes": ["*.scad", "LICENSE", "examples"],
  "zipExcludes": ["**/tests/**"],
  "workingDir": "."
}
```

Available build commands:

- `npm run build:libs` - Build all libraries
- `npm run build:libs:clean` - Clean all build artifacts
- `npm run build:libs:wasm` - Download/build just the WASM binary
- `npm run build:libs:fonts` - Download/build just the fonts
- `npm run build:libs:libraries` - Rebuild just the packaged library ZIPs and generated registry

Send us a PR, then once it's merged request an update to the hosted https://ochafik.com/openscad2 demo.
