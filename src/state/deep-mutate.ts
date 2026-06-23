// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KVObject = { [key: string]: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KVEntriesMap = Map<KVObject, [string, any][]>;

/**
 *
 * @param o the object we want to mutate
 * @param mutate a function that modifies any part of the object.
 * @returns an object tree in which each node is identical to its original if no value under its subtree truly changed. If any did, the node's identity is new.
 */
export function bubbleUpDeepMutations<T extends KVObject>(o: T, mutate: (o: T) => void): T {
  const allOriginalEntries = collectObjectEntriesDeeply(o);
  try {
    mutate(o);
  } catch (e) {
    // `mutate` edits the tree in place, so a callback that throws partway would
    // otherwise leave the live state partially mutated *and* with no change
    // event dispatched (the caller bails before setState). Roll every touched
    // object back to its captured entries so a failed mutation is a no-op, then
    // rethrow. (The proper long-term fix is explicit immutable reducers — #122.)
    restoreOriginalEntries(allOriginalEntries);
    throw e;
  }
  return bubbleChangesUp(o, allOriginalEntries) as T;
}

/**
 * Reset every captured object to exactly its original own-enumerable entries:
 * drop keys the mutation added, restore originals (pointing back at the original
 * child references, which are themselves restored as they were also captured),
 * and fix array length. Objects the mutation newly created aren't captured, but
 * become unreferenced once their would-be parents are restored.
 */
function restoreOriginalEntries(allOriginalEntries: KVEntriesMap) {
  for (const [obj, entries] of allOriginalEntries) {
    // Clear all current keys, then re-add the captured ones in their original
    // order, so a key the callback deleted is restored in place rather than at
    // the end — keeping JSON key order (and thus the persistence signature)
    // stable across a rolled-back mutation.
    for (const key of Object.keys(obj)) {
      delete obj[key];
    }
    for (const [k, v] of entries) {
      obj[k] = v;
    }
    if (Array.isArray(obj)) {
      obj.length = entries.length;
    }
  }
}

function collectObjectEntriesDeeply(o: KVObject, out: KVEntriesMap = new Map()): KVEntriesMap {
  if (out.get(o)) {
    return out; // Graph cycle
  }

  const entries = [...Object.entries(o)];
  out.set(o, entries);
  for (const [, v] of entries) {
    if (typeof v !== 'object') {
      continue;
    }
    if (v instanceof RegExp || v instanceof Blob) {
      continue;
    }
    // Captures plain objects/arrays only. Map/Set/File (extends Blob) internals
    // are treated as opaque, so an in-place mutation *inside* one would not be
    // rolled back. The State tree holds none in a mutated-in-place position
    // (e.g. output.outFile is replaced wholesale, never mutated), so this is
    // safe today; revisit if state grows such a field.
    collectObjectEntriesDeeply(v, out);
  }
  return out;
}

function bubbleChangesUp(o: KVObject, allOriginalEntries: KVEntriesMap) {
  if (o == null || typeof o !== 'object') {
    return o;
  }
  const entries = Object.entries(o);
  const originalEntries = allOriginalEntries.get(o);
  if (!originalEntries) {
    // the object has already changed as we can't find it, return it = new
    return o;
  }

  let changed = false;
  if (entries.length != originalEntries.length) {
    changed = true;
  } else {
    for (let i = 0; i < entries.length; i++) {
      const [originalName, originalValue] = originalEntries[i];
      const [newName, newValue] = entries[i];
      if (originalName !== newName) {
        changed = true;
        break;
      }
      const updatedValue = bubbleChangesUp(newValue, allOriginalEntries);
      if (updatedValue !== originalValue) {
        changed = true;
        break;
      }
    }
  }
  return changed ? Object.fromEntries(entries) : o;
}
