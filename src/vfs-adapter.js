// Unified Virtual File System Adapter
// Normalizes access across vfs-wasi OverlayVFS, Map<string, Uint8Array|string>, and plain objects.

import { EEXIST, ENOTEMPTY, EPERM, EROFS } from './constants.js';

const textEncoder = new TextEncoder();

/**
 * Normalizes a POSIX path string.
 * Preserves leading slash distinction (absolute vs. relative), collapses redundant slashes,
 * resolves '.' and '..' segments without escaping '/', and strips trailing slashes (except '/').
 *
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  if (!path) return '/';
  const isAbsolute = path.startsWith('/');
  const parts = path.split('/').filter((p) => p && p !== '.');
  const resolved = [];

  for (const part of parts) {
    if (part === '..') {
      if (resolved.length > 0) resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  const result = (isAbsolute ? '/' : '') + resolved.join('/');
  return result === '' ? '/' : result;
}

/**
 * Converts arbitrary stored payloads (Uint8Array, ArrayBuffer, string, or wrapper object)
 * into a Uint8Array.
 *
 * @param {any} value
 * @returns {Uint8Array}
 */
export function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return textEncoder.encode(value);
  if (value && typeof value === 'object') {
    if (value.data !== undefined) return toUint8Array(value.data);
    if (value.contents !== undefined) return toUint8Array(value.contents);
    if (value.content !== undefined) return toUint8Array(value.content);
  }
  return new Uint8Array(0);
}

/**
 * Adapter providing a consistent filesystem interface over OverlayVFS, Map, or plain objects.
 */
export class VfsAdapter {
  /**
   * @param {object|Map|null} vfs
   * @param {Set<string>} [createdDirs]
   */
  constructor(vfs = new Map(), createdDirs = new Set(['/'])) {
    this.vfs = vfs;
    this.createdDirs = createdDirs;
  }

  /**
   * Checks whether a path is protected as read-only by the underlying VFS.
   * @param {string} path
   * @returns {boolean}
   */
  isReadOnly(path) {
    if (this.vfs && typeof this.vfs._isReadOnly === 'function') {
      return Boolean(this.vfs._isReadOnly(path));
    }
    return false;
  }

  /**
   * Checks whether a file or directory exists at the normalized path.
   * @param {string} path
   * @returns {boolean}
   */
  exists(path) {
    if (!this.vfs) return false;
    const norm = normalizePath(path);
    if (norm === '/') return true;
    if (typeof this.vfs.exists === 'function') return Boolean(this.vfs.exists(norm));
    if (this.vfs instanceof Map) return this.vfs.has(norm) || this.isDir(norm);
    if (typeof this.vfs === 'object') {
      return Object.prototype.hasOwnProperty.call(this.vfs, norm) || this.isDir(norm);
    }
    return false;
  }

  /**
   * Checks whether the normalized path is a directory.
   * @param {string} path
   * @returns {boolean}
   */
  isDir(path) {
    if (!this.vfs) return false;
    const norm = normalizePath(path);
    if (norm === '/') return true;
    if (this.createdDirs && this.createdDirs.has(norm)) return true;

    if (typeof this.vfs.isDir === 'function') {
      return Boolean(this.vfs.isDir(norm));
    }
    if (typeof this.vfs.stat === 'function') {
      const s = this.vfs.stat(norm);
      return s ? Boolean(s.isDir || s.isDirectory) : false;
    }

    if (this.vfs instanceof Map) {
      if (this.vfs.has(norm)) {
        const item = this.vfs.get(norm);
        if (item && typeof item === 'object' && item.isDir !== undefined) {
          return Boolean(item.isDir);
        }
        return false;
      }
      const prefix = `${norm}/`;
      for (const k of this.vfs.keys()) {
        if (normalizePath(k).startsWith(prefix)) return true;
      }
      return false;
    }

    if (typeof this.vfs === 'object') {
      if (Object.prototype.hasOwnProperty.call(this.vfs, norm)) {
        const item = this.vfs[norm];
        if (item && typeof item === 'object' && item.isDir !== undefined) {
          return Boolean(item.isDir);
        }
        return false;
      }
      const prefix = `${norm}/`;
      for (const k of Object.keys(this.vfs)) {
        if (normalizePath(k).startsWith(prefix)) return true;
      }
      return false;
    }

    return false;
  }

  /**
   * Returns file/directory metadata `{ isDir, size, mtime }` or null if not found.
   * @param {string} path
   * @returns {{ isDir: boolean, size: number, mtime: number } | null}
   */
  stat(path) {
    if (!this.vfs) return null;
    const norm = normalizePath(path);

    if (typeof this.vfs.stat === 'function') {
      const st = this.vfs.stat(norm);
      if (st) {
        return {
          isDir: Boolean(st.isDir || st.isDirectory),
          size: Number(st.size || 0),
          mtime: Number(st.mtime || Date.now()),
        };
      }
    }

    if (this.isDir(norm)) {
      return { isDir: true, size: 0, mtime: Date.now() };
    }

    if (this.exists(norm)) {
      const bytes = this.readFile(norm);
      return { isDir: false, size: bytes.length, mtime: Date.now() };
    }

    return null;
  }

  /**
   * Reads file bytes from the underlying VFS.
   * @param {string} path
   * @returns {Uint8Array}
   */
  readFile(path) {
    if (!this.vfs) return new Uint8Array(0);
    const norm = normalizePath(path);
    let raw = null;

    if (typeof this.vfs.readFile === 'function') {
      raw = this.vfs.readFile(norm, false);
    } else if (this.vfs instanceof Map) {
      raw = this.vfs.get(norm);
    } else if (typeof this.vfs === 'object') {
      raw = this.vfs[norm];
    }

    return toUint8Array(raw);
  }

  /**
   * Writes file bytes into the underlying VFS, creating parent directories if needed.
   * @param {string} path
   * @param {Uint8Array|ArrayBuffer|string} data
   */
  writeFile(path, data) {
    const norm = normalizePath(path);
    if (this.isReadOnly(norm)) {
      const err = new Error(`EROFS: read-only file system, open '${norm}'`);
      err.errno = EROFS;
      throw err;
    }

    const bytes = toUint8Array(data);
    let dirP = norm;
    while (dirP.lastIndexOf('/') > 0) {
      dirP = dirP.substring(0, dirP.lastIndexOf('/'));
      this.createdDirs.add(dirP);
    }

    if (!this.vfs) return bytes;

    if (typeof this.vfs.writeFile === 'function') {
      const lastSlash = norm.lastIndexOf('/');
      if (lastSlash > 0) {
        const parentDir = norm.substring(0, lastSlash);
        if (!this.exists(parentDir)) {
          try {
            this._callMkdir(parentDir, true);
          } catch {}
        }
      }
      this.vfs.writeFile(norm, bytes, { mtime: Date.now(), allowReadOnly: false });
    } else if (this.vfs instanceof Map) {
      this.vfs.set(norm, bytes);
    } else if (typeof this.vfs === 'object') {
      this.vfs[norm] = bytes;
    }

    return bytes;
  }

  /**
   * Creates a directory in the underlying VFS.
   * @param {string} path
   * @param {boolean} [recursive=false]
   */
  mkdir(path, recursive = false) {
    const norm = normalizePath(path);
    if (this.isReadOnly(norm)) {
      const err = new Error(`EROFS: read-only file system, mkdir '${norm}'`);
      err.errno = EROFS;
      throw err;
    }

    if (this.vfs && typeof this.vfs.mkdir === 'function') {
      this._callMkdir(norm, recursive);
    }
    this.createdDirs.add(norm);
  }

  _callMkdir(norm, recursive) {
    this.vfs.mkdir(norm, { recursive, allowReadOnly: false });
  }

  /**
   * Removes a regular file from the underlying VFS.
   * @param {string} path
   */
  removeFile(path) {
    const norm = normalizePath(path);
    if (this.isReadOnly(norm)) {
      const err = new Error(`EROFS: read-only file system, unlink '${norm}'`);
      err.errno = EROFS;
      throw err;
    }

    if (!this.vfs) return;

    if (typeof this.vfs.removeFile === 'function') {
      this.vfs.removeFile(norm);
    } else if (typeof this.vfs.remove === 'function') {
      this.vfs.remove(norm, true, false);
    } else if (this.vfs instanceof Map) {
      this.vfs.delete(norm);
    } else if (typeof this.vfs === 'object') {
      delete this.vfs[norm];
    }
  }

  /**
   * Removes an empty directory from the underlying VFS.
   * @param {string} path
   */
  removeDir(path) {
    const norm = normalizePath(path);
    if (this.isReadOnly(norm)) {
      const err = new Error(`EROFS: read-only file system, rmdir '${norm}'`);
      err.errno = EROFS;
      throw err;
    }

    const children = this.readDir(norm);
    if (children.length > 0) {
      const err = new Error(`ENOTEMPTY: directory not empty, rmdir '${norm}'`);
      err.errno = ENOTEMPTY;
      throw err;
    }

    if (this.vfs) {
      if (typeof this.vfs.removeDir === 'function') {
        this.vfs.removeDir(norm, false);
      } else if (typeof this.vfs.rmdir === 'function') {
        this.vfs.rmdir(norm, false, false);
      } else if (typeof this.vfs.remove === 'function') {
        this.vfs.remove(norm, false, false);
      } else if (this.vfs instanceof Map) {
        const entry = this.vfs.get(norm);
        if (entry && typeof entry === 'object' && entry.isDir) {
          this.vfs.delete(norm);
        }
      } else if (typeof this.vfs === 'object') {
        const entry = this.vfs[norm];
        if (entry && typeof entry === 'object' && entry.isDir) {
          delete this.vfs[norm];
        }
      }
    }

    this.createdDirs.delete(norm);
  }

  /**
   * Renames or moves a file or directory.
   * @param {string} oldPath
   * @param {string} newPath
   */
  rename(oldPath, newPath) {
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);

    if (this.isReadOnly(oldNorm) || this.isReadOnly(newNorm)) {
      const err = new Error(`EROFS: read-only file system, rename '${oldNorm}' -> '${newNorm}'`);
      err.errno = EROFS;
      throw err;
    }

    if (this.vfs && typeof this.vfs.rename === 'function') {
      try {
        this.vfs.rename(oldNorm, newNorm, true);
      } catch (err) {
        if (!err.errno) err.errno = EEXIST;
        throw err;
      }
      return;
    }

    if (this.isDir(oldNorm)) {
      const prefix = `${oldNorm}/`;
      const toMove = [];
      if (this.vfs instanceof Map) {
        for (const [k, v] of this.vfs.entries()) {
          const nk = normalizePath(k);
          if (nk === oldNorm || nk.startsWith(prefix)) {
            toMove.push([nk, v]);
          }
        }
        for (const [nk, v] of toMove) {
          this.vfs.delete(nk);
          const suffix = nk.substring(oldNorm.length);
          this.vfs.set(newNorm + suffix, v);
        }
      } else if (this.vfs && typeof this.vfs === 'object') {
        for (const k of Object.keys(this.vfs)) {
          const nk = normalizePath(k);
          if (nk === oldNorm || nk.startsWith(prefix)) {
            toMove.push([nk, this.vfs[k]]);
          }
        }
        for (const [nk, v] of toMove) {
          delete this.vfs[nk];
          const suffix = nk.substring(oldNorm.length);
          this.vfs[newNorm + suffix] = v;
        }
      }
      this.createdDirs.delete(oldNorm);
      this.createdDirs.add(newNorm);
      return;
    }

    const bytes = this.readFile(oldNorm);
    this.writeFile(newNorm, bytes);
    this.removeFile(oldNorm);
  }

  /**
   * Updates modification/access timestamps on a file or directory.
   * @param {string} path
   * @param {bigint} atimNs
   * @param {bigint} mtimNs
   */
  setTimes(path, atimNs, mtimNs) {
    const norm = normalizePath(path);
    if (this.isReadOnly(norm)) {
      const err = new Error(`EROFS: read-only file system, utime '${norm}'`);
      err.errno = EROFS;
      throw err;
    }
    if (!this.vfs) return;

    if (typeof this.vfs.setTimes === 'function') {
      this.vfs.setTimes(norm, atimNs, mtimNs);
      return;
    }
    if (typeof this.vfs._resolve === 'function') {
      const node = this.vfs._resolve(norm);
      if (node) {
        node.mtime = Number(mtimNs / 1000000n);
        if (typeof this.vfs._notify === 'function') {
          this.vfs._notify({ type: 'write', path: norm, isDir: node.isDir, mtime: node.mtime });
        }
      }
    }
  }

  /**
   * Lists directory entries at the normalized path.
   * @param {string} path
   * @returns {Array<{ name: string, isDir: boolean }>}
   */
  readDir(path) {
    if (!this.vfs) return [];
    const norm = normalizePath(path);

    if (typeof this.vfs.readDir === 'function') {
      const items = this.vfs.readDir(norm);
      return items.map((i) => ({
        name: typeof i === 'string' ? i : i.name,
        isDir: typeof i === 'string'
          ? this.isDir(norm === '/' ? `/${i}` : `${norm}/${i}`)
          : Boolean(i.isDir || i.isDirectory),
      }));
    }

    const prefix = norm === '/' ? '/' : `${norm}/`;
    const seen = new Map();
    const keys = this.vfs instanceof Map ? Array.from(this.vfs.keys()) : Object.keys(this.vfs);

    for (const rawKey of keys) {
      const k = normalizePath(rawKey);
      if (k.startsWith(prefix)) {
        const rest = k.substring(prefix.length);
        if (!rest) continue;
        const slashIdx = rest.indexOf('/');
        const name = slashIdx === -1 ? rest : rest.substring(0, slashIdx);
        if (!name) continue;
        const isDir = slashIdx !== -1 || (
          this.vfs instanceof Map
            ? Boolean(this.vfs.get(rawKey)?.isDir)
            : Boolean(this.vfs[rawKey]?.isDir)
        );
        if (!seen.has(name) || isDir) {
          seen.set(name, { name, isDir });
        }
      }
    }

    for (const dirPath of this.createdDirs) {
      if (dirPath !== '/' && dirPath.startsWith(prefix)) {
        const rest = dirPath.substring(prefix.length);
        const name = rest.split('/')[0];
        if (name && !seen.has(name)) {
          seen.set(name, { name, isDir: true });
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Maps an internal error into a WASI errno fallback.
   * @param {any} err
   * @param {number} [fallback=EPERM]
   * @returns {number}
   */
  static mapErrorToErrno(err, fallback = EPERM) {
    if (err && typeof err.errno === 'number') return err.errno;
    if (err && typeof err.message === 'string') {
      if (err.message.includes('EROFS')) return EROFS;
      if (err.message.includes('not empty') || err.message.includes('ENOTEMPTY')) return ENOTEMPTY;
      if (err.message.includes('exists') || err.message.includes('EEXIST')) return EEXIST;
    }
    return fallback;
  }
}
