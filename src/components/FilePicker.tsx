// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import React, { CSSProperties, useContext } from 'react';
import { TreeSelect } from 'primereact/treeselect';
import { TreeNode } from 'primereact/treenode';
import { ModelContext, FSContext } from './contexts.ts';
import { getParentDir, join } from '../fs/filesystem.ts';
import { defaultSourcePath } from '../state/initial-state.ts';
import { zipArchives } from '../fs/zip-archives.generated.ts';

const biasedCompare = (a: string, b: string) =>
  a === 'openscad' ? -1 : b === 'openscad' ? 1 : a.localeCompare(b);

/**
 * Recursively lists .scad files and subdirectories under `path`.
 * When listing `/libraries`, adds GitHub and docs links for known archives.
 */
function listFilesAsNodes(fs: FS, path: string, accept?: (path: string) => boolean): TreeNode[] {
  const files: [string, string][] = [];
  const dirs: [string, string][] = [];
  for (const name of fs.readdirSync(path)) {
    if (name.startsWith('.')) continue;
    const childPath = join(path, name);
    if (accept && !accept(childPath)) continue;
    const stat = fs.lstatSync(childPath);
    const isDirectory = stat.isDirectory();
    if (!isDirectory && !name.endsWith('.scad')) continue;
    (isDirectory ? dirs : files).push([name, childPath]);
  }
  [files, dirs].forEach(arr => arr.sort(([a], [b]) => biasedCompare(a, b)));

  const nodes: TreeNode[] = [];
  for (const [arr, isDirectory] of [[files, false], [dirs, true]] as [[string, string][], boolean][]) {
    for (const [name, childPath] of arr) {
      let children: TreeNode[] = [];
      // Attach repo/docs links for direct children of /libraries
      if (path === '/libraries') {
        const archive = zipArchives.find(a => a.name === name);
        if (archive) {
          if (archive.repoUrl) {
            children.push({
              icon: 'pi pi-github',
              label: archive.repoUrl.replace('https://github.com/', ''),
              key: archive.repoUrl,
              selectable: true,
            });
          }
          for (const [label, link] of Object.entries(archive.docs ?? {})) {
            children.push({ icon: 'pi pi-book', label, key: link, selectable: true });
          }
        }
      }

      if (isDirectory) {
        children = [...children, ...listFilesAsNodes(fs, childPath, accept)];
        if (children.length === 0) continue;
      }

      nodes.push({
        icon: isDirectory ? 'pi pi-folder' : childPath === defaultSourcePath ? 'pi pi-home' : 'pi pi-file',
        label: name,
        data: childPath,
        key: childPath,
        children,
        selectable: !isDirectory,
      });
    }
  }
  return nodes;
}

export default function FilePicker({ className, style }: { className?: string; style?: CSSProperties }) {
  const model = useContext(ModelContext);
  if (!model) throw new Error('No model');
  const state = model.state;
  const fs = useContext(FSContext);

  const fsItems: TreeNode[] = [];

  // Add user files from /home (sources that are actively loaded)
  for (const { path } of state.params.sources) {
    const parent = getParentDir(path);
    if (parent === '/' || parent === '/home') {
      fsItems.push({
        icon: 'pi pi-home',
        label: path.split('/').pop(),
        data: path,
        key: path,
        selectable: true,
      });
    }
  }

  // Add library files from /libraries
  if (fs) {
    try {
      fsItems.push(...listFilesAsNodes(fs, '/libraries'));
    } catch {
      // /libraries may not be readable yet (race on first load) — skip silently
    }
  }

  return (
    <TreeSelect
      className={className}
      title='OpenSCAD Playground Files'
      value={state.params.activePath}
      resetFilterOnHide={true}
      filterBy="key"
      onChange={e => {
        const key = e.value;
        if (typeof key === 'string') {
          if (key.startsWith('https://')) {
            window.open(key, '_blank');
          } else {
            model.openFile(key);
          }
        }
      }}
      filter
      style={style}
      options={fsItems}
    />
  );
}

