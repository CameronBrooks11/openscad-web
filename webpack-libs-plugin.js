#!/usr/bin/env node

import AdmZip from 'adm-zip';
import { exec } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import https from 'node:https';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

class OpenSCADLibrariesPlugin {
    constructor(options = {}) {
        this.configFile = options.configFile || 'libs-config.json';
        this.libsDir = options.libsDir || 'libs';
        this.publicLibsDir = options.publicLibsDir || 'public/libraries';
        this.srcWasmDir = options.srcWasmDir || 'src/wasm';
        this.buildMode = options.buildMode || 'all'; // 'all', 'wasm', 'fonts', 'libs'
        this.config = null;
    }

    apply(compiler) {
        const pluginName = 'OpenSCADLibrariesPlugin';

        compiler.hooks.beforeRun.tapAsync(pluginName, async (_, callback) => {
            try {
                await this.loadConfig();

                switch (this.buildMode) {
                    case 'all':
                        await this.buildAll();
                        break;
                    case 'wasm':
                        await this.buildWasm();
                        break;
                    case 'fonts':
                        await this.buildFonts();
                        break;
                    case 'libs':
                        await this.buildAllLibraries();
                        break;
                    case 'clean':
                        await this.clean();
                        break;
                }

                callback();
            } catch (error) {
                callback(error);
            }
        });
    }

    async loadConfig() {
        try {
            const configContent = await fs.readFile(this.configFile, 'utf-8');
            this.config = JSON.parse(configContent);
        } catch (error) {
            throw new Error(`Failed to load config from ${this.configFile}: ${error.message}`);
        }
    }

    async ensureDir(dirPath) {
        try {
            await fs.mkdir(dirPath, { recursive: true });
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }
    }

    async downloadFile(url, outputPath, retries = 6, retryDelayMs = 2000) {
        console.log(`Downloading ${url} to ${outputPath}`);

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await this._downloadOnce(url, outputPath);
                return;
            } catch (err) {
                const isTransient = /5\d\d/.test(err.message) || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
                if (isTransient && attempt < retries) {
                    const delay = retryDelayMs * attempt;
                    console.warn(`Download failed (attempt ${attempt}/${retries}): ${err.message} — retrying in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    throw err;
                }
            }
        }
    }

    _downloadOnce(url, outputPath) {
        return new Promise((resolve, reject) => {
            https.get(url, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    return this._downloadOnce(response.headers.location, outputPath)
                        .then(resolve)
                        .catch(reject);
                }

                if (response.statusCode !== 200) {
                    response.resume(); // drain to free socket
                    reject(new Error(`Failed to download: ${response.statusCode}`));
                    return;
                }

                const fileStream = createWriteStream(outputPath);
                pipeline(response, fileStream)
                    .then(resolve)
                    .catch(reject);
            }).on('error', reject);
        });
    }

    async cloneRepo(repo, targetDir, branch = 'master', shallow = true) {
        const cloneArgs = [
            'clone',
            '--recurse',
            shallow ? '--depth 1' : '',
            `--branch ${branch}`,
            '--single-branch',
            repo,
            targetDir
        ].filter(Boolean);

        console.log(`Cloning ${repo} to ${targetDir}`);
        try {
            await execAsync(`git ${cloneArgs.join(' ')}`);
        } catch (error) {
            console.error(`Failed to clone ${repo}:`, error.message);
            throw error;
        }
    }

    async createZip(sourceDir, outputPath, includes = [], excludes = [], workingDir = '.') {
        await this.ensureDir(path.dirname(outputPath));

        const baseDir = path.resolve(path.join(sourceDir, workingDir));
        const zip = new AdmZip();

        // Walk and include files relative to baseDir
        const allFiles = await this.walkDir(baseDir);
        for (const absPath of allFiles) {
            const relPath = path.relative(baseDir, absPath).split(path.sep).join('/');
            const effectiveIncludes = includes.length > 0 ? includes : ['**/*.scad'];
            if (this.matchesAnyInclude(relPath, effectiveIncludes) && !this.matchesAnyExclude(relPath, excludes)) {
                zip.addFile(relPath, await fs.readFile(absPath));
            }
        }

        // Handle "../file" patterns (files outside workingDir, e.g. boltsparts' "../LICENSE")
        for (const pattern of includes) {
            if (!pattern.startsWith('../')) continue;
            const absPath = path.resolve(baseDir, pattern);
            if (existsSync(absPath)) {
                try {
                    const stat = await fs.stat(absPath);
                    if (stat.isFile()) {
                        zip.addFile(path.basename(pattern), await fs.readFile(absPath));
                    }
                } catch { /* ignore */ }
            }
        }

        zip.writeZip(path.resolve(outputPath));
        console.log(`Created zip: ${outputPath}`);
    }

    // Recursively list all files under dir.
    async walkDir(dir) {
        let files = [];
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return files;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files = files.concat(await this.walkDir(fullPath));
            } else if (entry.isFile()) {
                files.push(fullPath);
            }
        }
        return files;
    }

    matchesAnyInclude(relPath, includes) {
        for (const pattern of includes) {
            if (pattern.startsWith('../')) continue;
            if (this.matchIncludePattern(relPath, pattern)) return true;
        }
        return false;
    }

    // Match a relative file path against a single include pattern.
    // Mirrors the semantics of the original find commands.
    matchIncludePattern(relPath, pattern) {
        const segments = relPath.split('/');
        const filename = segments[segments.length - 1];

        if (pattern.includes('**')) {
            if (pattern.startsWith('**/')) {
                // "**/*.scad" → match filename at any depth
                return this.matchGlob(filename, pattern.slice(3));
            }
            // "examples/**/*.scad" → files under prefix dir matching file glob
            const patParts = pattern.split('/');
            const prefixDir = patParts[0];
            const fileGlob = patParts[patParts.length - 1];
            return segments[0] === prefixDir && this.matchGlob(filename, fileGlob);
        }

        if (pattern.includes('/')) {
            const patParts = pattern.split('/');
            const lastPart = patParts[patParts.length - 1];
            if (lastPart.includes('*')) {
                // "bitmap/*.scad" → files directly inside that directory
                return segments.length >= 2 && segments[segments.length - 2] === patParts[patParts.length - 2] && this.matchGlob(filename, lastPart);
            }
            // "examples/UBexamples" → exact path match or anything under it
            return relPath === pattern || relPath.startsWith(pattern + '/');
        }

        if (pattern.includes('*')) {
            // "*.scad" → match filename at any depth (find -name behaviour)
            return this.matchGlob(filename, pattern);
        }

        // Plain name ("LICENSE", "COPYING") → match filename anywhere, or exact path
        return filename === pattern || relPath === pattern || relPath.startsWith(pattern + '/');
    }

    matchGlob(name, pattern) {
        const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${re}$`).test(name);
    }

    matchesAnyExclude(relPath, excludes) {
        for (const pattern of excludes) {
            // "**/tests/**" → extract the directory name and check if it appears in the path
            const clean = pattern.replace(/\*\*\//g, '').replace(/\/\*\*/g, '').replace(/\*/g, '');
            if (clean && relPath.split('/').includes(clean)) return true;
        }
        return false;
    }

    async verifySha256(filePath, expectedSha256) {
        const hash = createHash('sha256');
        await new Promise((resolve, reject) => {
            const stream = createReadStream(filePath);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        const actual = hash.digest('hex');
        if (actual !== expectedSha256) {
            throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`);
        }
        console.log(`SHA256 verified: ${path.basename(filePath)}`);
    }

    async buildWasm() {
        const { wasmBuild } = this.config;
        const wasmDir = wasmBuild.target;
        const wasmZip = `${wasmDir}.zip`;
        const hashFile = `${wasmDir}.sha256`;

        await this.ensureDir(this.libsDir);

        // R1-2: always verify SHA256 against stored sidecar; re-download on mismatch.
        // This makes URL changes automatically trigger a fresh download.
        let needDownload = true;
        if (existsSync(hashFile) && existsSync(path.join(wasmDir, 'openscad.js'))) {
            const cachedHash = (await fs.readFile(hashFile, 'utf8')).trim();
            if (cachedHash === wasmBuild.sha256) {
                console.log('[build-wasm] Artifact up to date, skipping download.');
                needDownload = false;
            } else {
                console.log('[build-wasm] SHA256 mismatch — re-downloading artifact.');
                await fs.rm(wasmDir, { recursive: true, force: true });
                try { await fs.unlink(hashFile); } catch { /* ignore */ }
            }
        }

        if (needDownload) {
            await this.ensureDir(wasmDir);
            await this.downloadFile(wasmBuild.url, wasmZip);

            if (wasmBuild.sha256) {
                await this.verifySha256(wasmZip, wasmBuild.sha256);
            }

            console.log(`Extracting WASM to ${wasmDir}`);
            const zip = new AdmZip(path.resolve(wasmZip));
            zip.extractAllTo(path.resolve(wasmDir), /*overwrite=*/true);
            try { await fs.unlink(wasmZip); } catch { /* ignore */ }

            if (wasmBuild.sha256) {
                await fs.writeFile(hashFile, wasmBuild.sha256);
            }
        }

        await this.ensureDir('public');

        const jsTarget = 'public/openscad.js';
        const wasmTarget = 'public/openscad.wasm';

        // Remove existing symlinks/files
        for (const target of [jsTarget, wasmTarget, this.srcWasmDir]) {
            try { await fs.unlink(target); } catch { /* ignore */ }
        }

        // Try symlink first; fall back to copy on Windows where symlinks require elevated privileges
        const jsSrc = path.join(wasmDir, 'openscad.js');
        const wasmSrc = path.join(wasmDir, 'openscad.wasm');
        await this.createSymlinkOrCopy(path.relative('public', jsSrc), jsTarget, jsSrc);
        await this.createSymlinkOrCopy(path.relative('public', wasmSrc), wasmTarget, wasmSrc);
        await this.createSymlinkOrCopy(path.relative('src', wasmDir), this.srcWasmDir, wasmDir);

        console.log('WASM setup completed');
    }

    async createSymlinkOrCopy(linkTarget, linkPath, copySource) {
        try {
            await fs.symlink(linkTarget, linkPath);
        } catch (e) {
            if (e.code === 'EPERM' || e.code === 'EINVAL') {
                console.log(`  Symlink unavailable, copying ${copySource} → ${linkPath}`);
                const stat = await fs.stat(copySource);
                if (stat.isDirectory()) {
                    await this.copyDir(copySource, linkPath);
                } else {
                    await fs.copyFile(copySource, linkPath);
                }
            } else {
                throw e;
            }
        }
    }

    async copyDir(src, dest) {
        await this.ensureDir(dest);
        const entries = await fs.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                await this.copyDir(srcPath, destPath);
            } else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }

    async buildFonts() {
        const { fonts } = this.config;
        const notoDir = path.join(this.libsDir, 'noto');
        const liberationDir = path.join(this.libsDir, 'liberation');

        await this.ensureDir(notoDir);

        // Download Noto fonts
        for (const font of fonts.notoFonts) {
            const fontPath = path.join(notoDir, font);
            if (!existsSync(fontPath)) {
                const url = fonts.notoBaseUrl + font;
                await this.downloadFile(url, fontPath);
            }
        }

        // Clone liberation fonts if not exists
        if (!existsSync(liberationDir)) {
            await this.cloneRepo(fonts.liberationRepo, liberationDir, fonts.liberationBranch);
        }

        // Create fonts zip — files go flat at zip root (replicating original `zip -j` behaviour)
        const fontsZip = path.join(this.publicLibsDir, 'fonts.zip');
        await this.ensureDir(this.publicLibsDir);

        console.log('Creating fonts.zip');
        const zip = new AdmZip();

        zip.addLocalFile('fonts.conf');

        for (const f of await fs.readdir(notoDir)) {
            if (f.endsWith('.ttf')) zip.addLocalFile(path.join(notoDir, f));
        }

        for (const f of await fs.readdir(liberationDir)) {
            if (f.endsWith('.ttf') || f === 'LICENSE' || f === 'AUTHORS') {
                zip.addLocalFile(path.join(liberationDir, f));
            }
        }

        zip.writeZip(path.resolve(fontsZip));
        console.log('Fonts setup completed');
    }

    async buildLibrary(library) {
        const libDir = path.join(this.libsDir, library.name);
        const zipPath = path.join(this.publicLibsDir, `${library.name}.zip`);

        // Clone repository if not exists.
        // R1-3: When a commit pin is set we need the full history, so skip --depth 1.
        // Shallow clones only fetch the branch tip; an arbitrary pinned commit won't be
        // present in the shallow pack and git checkout will fail with "unable to read tree".
        if (!existsSync(libDir)) {
            await this.cloneRepo(library.repo, libDir, library.branch, /*shallow=*/!library.commit);
        }

        // R1-3: if a commit pin is specified, checkout exactly that commit
        if (library.commit) {
            await execAsync(`git -C ${libDir} checkout --quiet ${library.commit}`);
            console.log(`Pinned ${library.name} @ ${library.commit.slice(0, 12)}`);
        }

        // Create zip
        await this.createZip(
            libDir,
            zipPath,
            library.zipIncludes || ['*.scad'],
            library.zipExcludes || [],
            library.workingDir || '.'
        );

        console.log(`Built ${library.name}`);
    }

    async buildAllLibraries() {
        await this.ensureDir(this.publicLibsDir);

        for (const library of this.config.libraries) {
            await this.buildLibrary(library);
        }
    }

    async clean() {
        console.log('Cleaning build artifacts...');

        const cleanPaths = [
            this.libsDir,
            'build',
            'public/openscad.js',
            'public/openscad.wasm',
            this.publicLibsDir,
            this.srcWasmDir,
        ];

        for (const cleanPath of cleanPaths) {
            try {
                await fs.rm(cleanPath, { recursive: true, force: true });
            } catch { /* ignore */ }
        }

        console.log('Clean completed');
    }

    async buildAll() {
        console.log('Building all libraries...');

        await this.buildWasm();
        await this.buildFonts();
        await this.buildAllLibraries();

        console.log('Build completed successfully!');
    }
}

export default OpenSCADLibrariesPlugin;
