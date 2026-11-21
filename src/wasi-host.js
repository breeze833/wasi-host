// Language-Neutral WASI Preview 1 (wasi_snapshot_preview1) Process & Execution Host
// Zero runtime dependencies; composes with vfs-wasi, stdin-wasi, and busybox-wasi.

import {
  ESUCCESS,
  EBADF,
  EEXIST,
  EINVAL,
  EISDIR,
  ENOENT,
  ENOSYS,
  ENOTDIR,
  EPERM,
  EROFS,
  FILETYPE_CHARACTER_DEVICE,
  FILETYPE_DIRECTORY,
  FILETYPE_REGULAR_FILE,
  PREOPENTYPE_DIR,
  O_CREAT,
  O_DIRECTORY,
  O_EXCL,
  O_TRUNC,
  FDFLAG_APPEND,
  WHENCE_SET,
  WHENCE_CUR,
  WHENCE_END,
  CLOCKID_REALTIME,
  CLOCKID_MONOTONIC,
  EVENTTYPE_CLOCK,
  SUBCLOCKFLAGS_ABSTIME,
  FSTFLAGS_ATIM,
  FSTFLAGS_ATIM_NOW,
  FSTFLAGS_MTIM,
  FSTFLAGS_MTIM_NOW,
  RIGHTS_ALL,
  RIGHT_FD_READ,
  RIGHT_FD_WRITE,
  RIGHTS_TTY,
} from './constants.js';
import { VfsAdapter, normalizePath } from './vfs-adapter.js';

export { normalizePath };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });
const HAS_SAB = typeof SharedArrayBuffer !== 'undefined';

/**
 * Error thrown by WASI `proc_exit(code)` to unwind guest execution cleanly
 * while carrying the exit code and tracked filesystem mutations.
 */
export class ProcExit extends Error {
  /**
   * @param {number} code
   * @param {Map<string, Uint8Array>|null} [changedFiles=null]
   * @param {Set<string>|null} [deletedFiles=null]
   */
  constructor(code, changedFiles = null, deletedFiles = null) {
    super(`Exited with code ${code}`);
    this.name = 'ProcExit';
    this.code = code;
    this.changedFiles = changedFiles;
    this.deletedFiles = deletedFiles;
  }
}

/**
 * Pure JavaScript WASI Preview 1 (`wasi_snapshot_preview1` & `wasi_unstable`) host runtime.
 */
export class WasiHost {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.cwd = normalizePath(options.cwd || '/');
    this.argv = Array.isArray(options.argv) ? [...options.argv] : ['wasm'];
    this.environ = {
      HOME: this.cwd,
      PWD: this.cwd,
      ...(options.environ || {}),
    };

    if (typeof options.stdin === 'string') {
      this.stdin = textEncoder.encode(options.stdin);
    } else {
      this.stdin = options.stdin || null;
    }
    this.stdinPos = 0;

    this.stdout = options.stdout || (() => {});
    this.stderr = options.stderr || this.stdout;
    this.getMemory = options.getMemory || null;

    this.preopens = Array.isArray(options.preopens)
      ? options.preopens.map((p) => ({
          fd: p.fd,
          path: normalizePath(p.path),
          name: p.name !== undefined ? p.name : p.path,
        }))
      : [
          { fd: 3, path: this.cwd, name: '.' },
          { fd: 4, path: '/', name: '/' },
        ];

    const rawSystemDirs = Array.isArray(options.systemDirs) ? options.systemDirs : ['/dev'];
    this.systemDirs = new Set(rawSystemDirs.map((d) => normalizePath(d)));
    this.systemDirs.add('/dev');

    this.nextFd = typeof options.nextFd === 'number' ? options.nextFd : 10;
    this.onFileSync = options.onFileSync || null;
    this.onFileDelete = options.onFileDelete || null;
    this.wasiWrapper = options.wasiWrapper || null;
    this.envProvider = options.envProvider || null;
    this.customFsImports = options.fsImports || null;
    this.strictStubs = Boolean(options.strictStubs);

    this.changedFiles = new Map();
    this.deletedFiles = new Set();
    this.createdDirs = new Set(['/', ...this.systemDirs]);
    if (this.cwd && this.cwd !== '/') {
      this.createdDirs.add(this.cwd);
    }

    this.vfs = options.vfs !== undefined ? options.vfs : new Map();
    this.vfsAdapter = new VfsAdapter(this.vfs, this.createdDirs);

    this.openFiles = new Map();
    this.openFiles.set(0, { fd: 0, isStdio: true, canRead: true, canWrite: false, isDir: false });
    this.openFiles.set(1, { fd: 1, isStdio: true, canRead: false, canWrite: true, isDir: false });
    this.openFiles.set(2, { fd: 2, isStdio: true, canRead: false, canWrite: true, isDir: false });

    this._reservedFds = new Set();
    this.inodes = new Map();
    this.nextInode = 100n;
    this._sleepSyncBuffer = null;
  }

  /**
   * Binds WebAssembly linear memory (instance or getter function).
   * @param {WebAssembly.Memory|(() => WebAssembly.Memory)} memoryOrGetter
   */
  setMemory(memoryOrGetter) {
    this.getMemory = memoryOrGetter;
  }

  /**
   * Returns the active WebAssembly.Memory instance.
   * @returns {WebAssembly.Memory}
   */
  mem() {
    const memory = typeof this.getMemory === 'function' ? this.getMemory() : this.getMemory;
    if (!memory || !memory.buffer) {
      throw new Error('WasiHost: WebAssembly.Memory is not available or detached.');
    }
    return memory;
  }

  memU8() {
    return new Uint8Array(this.mem().buffer);
  }

  memView() {
    return new DataView(this.mem().buffer);
  }

  /**
   * Allocates the next available file descriptor >= max(minFd, nextFd).
   * Reserves the descriptor to guarantee uniqueness across consecutive calls.
   *
   * @param {number} [minFd=0]
   * @returns {number}
   */
  allocateFd(minFd = 0) {
    const preopenFds = new Set(this.preopens.map((p) => p.fd));
    let fd = Math.max(Number(minFd) || 0, this.nextFd);
    while (this.openFiles.has(fd) || preopenFds.has(fd) || this._reservedFds.has(fd)) {
      fd++;
    }
    this._reservedFds.add(fd);
    if (fd >= this.nextFd) {
      this.nextFd = fd + 1;
    }
    return fd;
  }

  _getInode(path) {
    const norm = normalizePath(path);
    if (!this.inodes.has(norm)) {
      this.inodes.set(norm, this.nextInode++);
    }
    return this.inodes.get(norm);
  }

  /**
   * Decodes a UTF-8 string from WebAssembly linear memory safely (SharedArrayBuffer compliant).
   * @param {number} offset
   * @param {number} [len=-1]
   * @returns {string}
   */
  readStr(offset, len = -1) {
    const u8 = this.memU8();
    let end = offset;
    if (len !== -1 && len !== undefined) {
      if (len === 0) return '';
      end = offset + len;
    } else {
      while (end < u8.length && u8[end] !== 0) {
        end++;
      }
    }

    const slice = u8.subarray(offset, end);
    if (HAS_SAB && u8.buffer instanceof SharedArrayBuffer) {
      const unshared = new Uint8Array(slice.length);
      unshared.set(slice);
      return textDecoder.decode(unshared);
    }
    return textDecoder.decode(slice);
  }

  _isSystemRelPath(cleanRel) {
    for (const sysDir of this.systemDirs) {
      const stripped = sysDir.replace(/^\/+/, '');
      if (stripped && (cleanRel === stripped || cleanRel.startsWith(`${stripped}/`))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves a path relative to a preopened or opened directory file descriptor.
   * @param {number} dirfd
   * @param {string} pathStr
   * @returns {string}
   */
  resolvePath(dirfd, pathStr) {
    let base = this.cwd;
    for (const preopen of this.preopens) {
      if (preopen.fd === dirfd) {
        base = preopen.path;
        break;
      }
    }
    const openEntry = this.openFiles.get(dirfd);
    if (openEntry && openEntry.isDir && openEntry.path) {
      base = openEntry.path;
    }

    if (!pathStr || pathStr === '.') return normalizePath(base);
    if (pathStr.startsWith('/')) return normalizePath(pathStr);

    const clean = pathStr.replace(/^\.?\/+/, '');
    if (!clean) return normalizePath(base);

    const candidate = normalizePath(`${base}/${clean}`);
    if (candidate === '/dev/null' || candidate === '/dev/zero') {
      return candidate;
    }
    if (this.vfsAdapter.exists(candidate) || this.vfsAdapter.isDir(candidate)) {
      return candidate;
    }

    if (base === '/' && this.cwd && this.cwd !== '/') {
      const firstSegment = clean.split('/')[0];
      const isRootEntry = this.vfsAdapter.isDir('/' + firstSegment) || this.vfsAdapter.exists('/' + firstSegment);
      if (!isRootEntry) {
        const cwdCandidate = normalizePath(`${this.cwd}/${clean}`);
        if (this.vfsAdapter.exists(cwdCandidate) || this.vfsAdapter.isDir(cwdCandidate)) {
          return cwdCandidate;
        }
        if (!this._isSystemRelPath(clean)) {
          return cwdCandidate;
        }
      }
    }

    if (this._isSystemRelPath(clean)) {
      const rootCandidate = normalizePath(`/${clean}`);
      if (
        rootCandidate === '/dev/null' ||
        rootCandidate === '/dev/zero' ||
        this.vfsAdapter.exists(rootCandidate) ||
        this.vfsAdapter.isDir(rootCandidate)
      ) {
        return rootCandidate;
      }
    }

    return candidate;
  }

  _writeFileAndTrack(fullPath, bytes) {
    const written = this.vfsAdapter.writeFile(fullPath, bytes);
    this.changedFiles.set(fullPath, written);
    this.deletedFiles.delete(fullPath);
    if (this.onFileSync) {
      try {
        this.onFileSync(fullPath, written);
      } catch {}
    }
    return written;
  }

  _removeFileAndTrack(fullPath) {
    this.vfsAdapter.removeFile(fullPath);
    this.changedFiles.delete(fullPath);
    this.deletedFiles.add(fullPath);
    if (this.onFileDelete) {
      try {
        this.onFileDelete(fullPath);
      } catch {}
    }
  }

  _writeFilestat(view, statOut, { ino, filetype, size, mtimeMs }) {
    this.memU8().fill(0, statOut, statOut + 64);
    const tsNs = BigInt(Math.max(0, Math.floor(mtimeMs || Date.now()))) * 1000000n;
    view.setBigUint64(statOut, 1n, true); // st_dev
    view.setBigUint64(statOut + 8, ino, true); // st_ino
    view.setUint8(statOut + 16, filetype); // st_filetype
    view.setBigUint64(statOut + 24, 1n, true); // st_nlink
    view.setBigUint64(statOut + 32, BigInt(size || 0), true); // st_size
    view.setBigUint64(statOut + 40, tsNs, true); // st_atim
    view.setBigUint64(statOut + 48, tsNs, true); // st_mtim
    view.setBigUint64(statOut + 56, tsNs, true); // st_ctim
  }

  _writeFdstat(view, statOut, { filetype, fdflags = 0, rightsBase = RIGHTS_ALL, rightsInheriting = RIGHTS_ALL }) {
    this.memU8().fill(0, statOut, statOut + 24);
    view.setUint8(statOut, filetype);
    view.setUint16(statOut + 2, fdflags, true);
    view.setBigUint64(statOut + 8, rightsBase, true);
    view.setBigUint64(statOut + 16, rightsInheriting, true);
  }

  _readIovecs(view, iovsPtr, iovsLen) {
    const result = [];
    for (let i = 0; i < iovsLen; i++) {
      const base = iovsPtr + i * 8;
      result.push({
        ptr: view.getUint32(base, true),
        len: view.getUint32(base + 4, true),
      });
    }
    return result;
  }

  _resolveMtimeNs(fstFlags, mtim) {
    const nowNs = BigInt(Date.now()) * 1000000n;
    if ((fstFlags & FSTFLAGS_MTIM) !== 0) return mtim;
    if ((fstFlags & FSTFLAGS_MTIM_NOW) !== 0) return nowNs;
    return nowNs;
  }

  _resolveAtimeNs(fstFlags, atim) {
    const nowNs = BigInt(Date.now()) * 1000000n;
    if ((fstFlags & FSTFLAGS_ATIM) !== 0) return atim;
    if ((fstFlags & FSTFLAGS_ATIM_NOW) !== 0) return nowNs;
    return nowNs;
  }

  _getPreopen(fd) {
    for (const preopen of this.preopens) {
      if (preopen.fd === fd) return preopen;
    }
    return null;
  }

  _isCharDevPath(fullPath) {
    return fullPath === '/dev/null' || fullPath === '/dev/zero';
  }

  _openEntry(entry) {
    this._reservedFds.delete(entry.fd);
    this.openFiles.set(entry.fd, entry);
  }

  _readDirWithDevices(dirPath) {
    const entries = this.vfsAdapter.readDir(dirPath);
    if (normalizePath(dirPath) === '/dev') {
      const names = new Set(entries.map((e) => e.name));
      if (!names.has('null')) entries.push({ name: 'null', isDir: false, isCharDev: true });
      if (!names.has('zero')) entries.push({ name: 'zero', isDir: false, isCharDev: true });
    }
    return entries;
  }

  /**
   * Builds and returns the WASI Preview 1 syscall table (`wasi_snapshot_preview1`).
   * @returns {Record<string, Function>}
   */
  getImports() {
    const wasi = {
      proc_exit: (code) => {
        throw new ProcExit(code, this.changedFiles, this.deletedFiles);
      },

      fd_prestat_get: (fd, statOut) => {
        const preopen = this._getPreopen(fd);
        if (!preopen) return EBADF;
        const view = this.memView();
        const nameBytes = textEncoder.encode(preopen.name);
        view.setUint32(statOut, PREOPENTYPE_DIR, true);
        view.setUint32(statOut + 4, nameBytes.length, true);
        return ESUCCESS;
      },

      fd_prestat_dir_name: (fd, pathPtr, pathLen) => {
        const preopen = this._getPreopen(fd);
        if (!preopen) return EBADF;
        const nameBytes = textEncoder.encode(preopen.name);
        const toCopy = Math.min(nameBytes.length, pathLen);
        this.memU8().set(nameBytes.subarray(0, toCopy), pathPtr);
        return ESUCCESS;
      },

      fd_fdstat_get: (fd, statOut) => {
        const view = this.memView();
        const file = this.openFiles.get(fd);
        if ((fd === 0 || fd === 1 || fd === 2) && (!file || file.isStdio)) {
          this._writeFdstat(view, statOut, {
            filetype: FILETYPE_CHARACTER_DEVICE,
            rightsBase: RIGHTS_TTY,
            rightsInheriting: RIGHTS_TTY,
          });
          return ESUCCESS;
        }

        if (this._getPreopen(fd)) {
          this._writeFdstat(view, statOut, { filetype: FILETYPE_DIRECTORY });
          return ESUCCESS;
        }

        if (!file) return EBADF;

        if (file.isCharDev) {
          this._writeFdstat(view, statOut, { filetype: FILETYPE_CHARACTER_DEVICE });
          return ESUCCESS;
        }

        this._writeFdstat(view, statOut, {
          filetype: file.isDir ? FILETYPE_DIRECTORY : FILETYPE_REGULAR_FILE,
          fdflags: file.isAppend ? FDFLAG_APPEND : 0,
        });
        return ESUCCESS;
      },

      fd_fdstat_set_flags: (fd, flags) => {
        const file = this.openFiles.get(fd);
        if (!file) return EBADF;
        file.isAppend = (flags & FDFLAG_APPEND) !== 0;
        return ESUCCESS;
      },

      fd_fdstat_set_rights: () => ESUCCESS,

      fd_filestat_get: (fd, statOut) => {
        const view = this.memView();
        if (fd === 0 || fd === 1 || fd === 2) {
          this._writeFilestat(view, statOut, {
            ino: BigInt(fd),
            filetype: FILETYPE_CHARACTER_DEVICE,
            size: 0,
            mtimeMs: Date.now(),
          });
          return ESUCCESS;
        }

        const preopen = this._getPreopen(fd);
        if (preopen) {
          const st = this.vfsAdapter.stat(preopen.path);
          this._writeFilestat(view, statOut, {
            ino: this._getInode(preopen.path),
            filetype: FILETYPE_DIRECTORY,
            size: 0,
            mtimeMs: st ? st.mtime : Date.now(),
          });
          return ESUCCESS;
        }

        const file = this.openFiles.get(fd);
        if (!file) return EBADF;

        if (file.isCharDev) {
          this._writeFilestat(view, statOut, {
            ino: this._getInode(file.path),
            filetype: FILETYPE_CHARACTER_DEVICE,
            size: 0,
            mtimeMs: Date.now(),
          });
          return ESUCCESS;
        }

        const st = this.vfsAdapter.stat(file.path);
        if (file.isDir) {
          this._writeFilestat(view, statOut, {
            ino: this._getInode(file.path),
            filetype: FILETYPE_DIRECTORY,
            size: 0,
            mtimeMs: st ? st.mtime : Date.now(),
          });
          return ESUCCESS;
        }

        const data = this.vfsAdapter.readFile(file.path);
        this._writeFilestat(view, statOut, {
          ino: this._getInode(file.path),
          filetype: FILETYPE_REGULAR_FILE,
          size: data.length,
          mtimeMs: st ? st.mtime : Date.now(),
        });
        return ESUCCESS;
      },

      fd_filestat_set_size: (fd, size) => {
        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canWrite) return EBADF;
        if (file.isCharDev) return ESUCCESS;
        if (this.vfsAdapter.isReadOnly(file.path)) return EROFS;

        const targetLen = Math.max(0, Number(size));
        const data = this.vfsAdapter.readFile(file.path);
        const nextData = new Uint8Array(targetLen);
        nextData.set(data.subarray(0, Math.min(data.length, targetLen)));
        this._writeFileAndTrack(file.path, nextData);
        return ESUCCESS;
      },

      fd_filestat_set_times: (fd, atim, mtim, fstFlags) => {
        const preopen = this._getPreopen(fd);
        const targetPath = preopen ? preopen.path : this.openFiles.get(fd)?.path;
        if (!targetPath) return EBADF;
        if (this.vfsAdapter.isReadOnly(targetPath)) return EROFS;
        try {
          this.vfsAdapter.setTimes(
            targetPath,
            this._resolveAtimeNs(fstFlags, atim),
            this._resolveMtimeNs(fstFlags, mtim)
          );
          if (!this.vfsAdapter.isDir(targetPath) && this.vfsAdapter.exists(targetPath)) {
            const bytes = this.vfsAdapter.readFile(targetPath);
            this.changedFiles.set(targetPath, bytes);
          }
          return ESUCCESS;
        } catch (err) {
          return VfsAdapter.mapErrorToErrno(err, EPERM);
        }
      },

      path_filestat_get: (dirfd, flags, pathPtr, pathLen, statOut) => {
        const pathStr = this.readStr(pathPtr, pathLen);
        const fullPath = this.resolvePath(dirfd, pathStr);
        const view = this.memView();

        if (this._isCharDevPath(fullPath)) {
          this._writeFilestat(view, statOut, {
            ino: this._getInode(fullPath),
            filetype: FILETYPE_CHARACTER_DEVICE,
            size: 0,
            mtimeMs: Date.now(),
          });
          return ESUCCESS;
        }

        if (this.vfsAdapter.isDir(fullPath)) {
          const st = this.vfsAdapter.stat(fullPath);
          this._writeFilestat(view, statOut, {
            ino: this._getInode(fullPath),
            filetype: FILETYPE_DIRECTORY,
            size: 0,
            mtimeMs: st ? st.mtime : Date.now(),
          });
          return ESUCCESS;
        }

        if (this.vfsAdapter.exists(fullPath)) {
          const st = this.vfsAdapter.stat(fullPath);
          const data = this.vfsAdapter.readFile(fullPath);
          this._writeFilestat(view, statOut, {
            ino: this._getInode(fullPath),
            filetype: FILETYPE_REGULAR_FILE,
            size: data.length,
            mtimeMs: st ? st.mtime : Date.now(),
          });
          return ESUCCESS;
        }

        return ENOENT;
      },

      path_filestat_set_times: (dirfd, flags, pathPtr, pathLen, atim, mtim, fstFlags) => {
        const pathStr = this.readStr(pathPtr, pathLen);
        const fullPath = this.resolvePath(dirfd, pathStr);
        if (!this.vfsAdapter.exists(fullPath) && !this.vfsAdapter.isDir(fullPath)) {
          return ENOENT;
        }
        if (this.vfsAdapter.isReadOnly(fullPath)) return EROFS;
        try {
          this.vfsAdapter.setTimes(
            fullPath,
            this._resolveAtimeNs(fstFlags, atim),
            this._resolveMtimeNs(fstFlags, mtim)
          );
          if (!this.vfsAdapter.isDir(fullPath) && this.vfsAdapter.exists(fullPath)) {
            const bytes = this.vfsAdapter.readFile(fullPath);
            this.changedFiles.set(fullPath, bytes);
          }
          return ESUCCESS;
        } catch (err) {
          return VfsAdapter.mapErrorToErrno(err, EPERM);
        }
      },

      path_open: (
        dirfd,
        dirflags,
        pathPtr,
        pathLen,
        oflags,
        fsRightsBase,
        fsRightsInheriting,
        fdflags,
        openedFdPtr
      ) => {
        const pathStr = this.readStr(pathPtr, pathLen);
        const fullPath = this.resolvePath(dirfd, pathStr);
        const view = this.memView();

        if (this._isCharDevPath(fullPath)) {
          if (oflags & O_DIRECTORY) return ENOTDIR;
          const fd = this.allocateFd();
          this._openEntry({
            fd,
            path: fullPath,
            isCharDev: true,
            isDevNull: fullPath === '/dev/null',
            isDevZero: fullPath === '/dev/zero',
            isDir: false,
            canRead: true,
            canWrite: true,
            isAppend: false,
            cursor: 0,
          });
          view.setUint32(openedFdPtr, fd, true);
          return ESUCCESS;
        }

        if (oflags & O_DIRECTORY) {
          if (this.vfsAdapter.isDir(fullPath)) {
            const fd = this.allocateFd();
            this._openEntry({
              fd,
              path: fullPath,
              isDir: true,
              canRead: true,
              canWrite: false,
              isAppend: false,
              cursor: 0,
            });
            view.setUint32(openedFdPtr, fd, true);
            return ESUCCESS;
          }
          return this.vfsAdapter.exists(fullPath) ? ENOTDIR : ENOENT;
        }

        const rightsBig = typeof fsRightsBase === 'bigint' ? fsRightsBase : BigInt(fsRightsBase || 0);
        const canRead = rightsBig === 0n || (rightsBig & RIGHT_FD_READ) !== 0n;
        const canWrite =
          rightsBig === 0n
            ? Boolean((oflags & (O_CREAT | O_TRUNC)) || (fdflags & FDFLAG_APPEND))
            : (rightsBig & RIGHT_FD_WRITE) !== 0n;
        const isAppend = (fdflags & FDFLAG_APPEND) !== 0;

        const isReadOnly = this.vfsAdapter.isReadOnly(fullPath);
        if (isReadOnly && ((oflags & (O_CREAT | O_TRUNC)) !== 0 || isAppend || canWrite)) {
          return EROFS;
        }

        if (this.vfsAdapter.isDir(fullPath)) {
          return EISDIR;
        }

        const exists = this.vfsAdapter.exists(fullPath);
        if (exists) {
          if ((oflags & O_CREAT) && (oflags & O_EXCL)) {
            return EEXIST;
          }
          if (oflags & O_TRUNC) {
            this._writeFileAndTrack(fullPath, new Uint8Array(0));
          }
        } else {
          if (!(oflags & O_CREAT)) {
            return ENOENT;
          }
          this._writeFileAndTrack(fullPath, new Uint8Array(0));
        }

        const curData = this.vfsAdapter.readFile(fullPath);
        const fd = this.allocateFd();
        this._openEntry({
          fd,
          path: fullPath,
          isDir: false,
          canRead,
          canWrite,
          isAppend,
          cursor: isAppend ? curData.length : 0,
        });

        view.setUint32(openedFdPtr, fd, true);
        return ESUCCESS;
      },

      fd_close: (fd) => {
        if (fd >= 0 && fd <= 2) return ESUCCESS;
        this._reservedFds.delete(fd);
        if (!this.openFiles.has(fd)) return EBADF;
        this.openFiles.delete(fd);
        return ESUCCESS;
      },

      fd_read: (fd, iovsPtr, iovsLen, nreadOut) => {
        const view = this.memView();
        const file = this.openFiles.get(fd);
        if (file && file.isStdio) {
          if (typeof this.stdin === 'function') {
            return this.stdin(iovsPtr, iovsLen, nreadOut, this);
          }
          if (this.stdin instanceof Uint8Array || Array.isArray(this.stdin)) {
            const preloaded = this.stdin instanceof Uint8Array ? this.stdin : new Uint8Array(this.stdin);
            const iovecs = this._readIovecs(view, iovsPtr, iovsLen);
            let totalRead = 0;
            for (const { ptr, len } of iovecs) {
              if (len <= 0) continue;
              const available = preloaded.length - this.stdinPos;
              if (available <= 0) break;
              const toCopy = Math.min(len, available);
              this.memU8().set(preloaded.subarray(this.stdinPos, this.stdinPos + toCopy), ptr);
              this.stdinPos += toCopy;
              totalRead += toCopy;
              if (toCopy < len) break;
            }
            view.setUint32(nreadOut, totalRead, true);
            return ESUCCESS;
          }
          view.setUint32(nreadOut, 0, true);
          return ESUCCESS;
        }

        if (!file || file.isDir || !file.canRead) return EBADF;

        if (file.isDevNull) {
          view.setUint32(nreadOut, 0, true);
          return ESUCCESS;
        }

        const iovecs = this._readIovecs(view, iovsPtr, iovsLen);
        if (file.isDevZero) {
          let totalRead = 0;
          const u8 = this.memU8();
          for (const { ptr, len } of iovecs) {
            if (len <= 0) continue;
            u8.fill(0, ptr, ptr + len);
            totalRead += len;
          }
          view.setUint32(nreadOut, totalRead, true);
          return ESUCCESS;
        }

        const data = this.vfsAdapter.readFile(file.path);
        const u8 = this.memU8();
        let totalRead = 0;

        for (const { ptr, len } of iovecs) {
          if (len <= 0) continue;
          const available = Math.max(0, data.length - file.cursor);
          if (available === 0) break;
          const toCopy = Math.min(len, available);
          u8.set(data.subarray(file.cursor, file.cursor + toCopy), ptr);
          file.cursor += toCopy;
          totalRead += toCopy;
          if (toCopy < len) break;
        }

        view.setUint32(nreadOut, totalRead, true);
        return ESUCCESS;
      },

      fd_pread: (fd, iovsPtr, iovsLen, offset, nreadOut) => {
        const view = this.memView();
        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canRead) return EBADF;

        if (file.isDevNull) {
          view.setUint32(nreadOut, 0, true);
          return ESUCCESS;
        }

        const iovecs = this._readIovecs(view, iovsPtr, iovsLen);
        const u8 = this.memU8();

        if (file.isDevZero) {
          let totalRead = 0;
          for (const { ptr, len } of iovecs) {
            if (len <= 0) continue;
            u8.fill(0, ptr, ptr + len);
            totalRead += len;
          }
          view.setUint32(nreadOut, totalRead, true);
          return ESUCCESS;
        }

        const data = this.vfsAdapter.readFile(file.path);
        let pos = Number(offset);
        if (pos < 0) return EINVAL;
        let totalRead = 0;

        for (const { ptr, len } of iovecs) {
          if (len <= 0) continue;
          const available = Math.max(0, data.length - pos);
          if (available === 0) break;
          const toCopy = Math.min(len, available);
          u8.set(data.subarray(pos, pos + toCopy), ptr);
          pos += toCopy;
          totalRead += toCopy;
          if (toCopy < len) break;
        }

        view.setUint32(nreadOut, totalRead, true);
        return ESUCCESS;
      },

      fd_write: (fd, iovsPtr, iovsLen, nwrittenOut) => {
        const view = this.memView();
        const file = this.openFiles.get(fd);
        const iovecs = this._readIovecs(view, iovsPtr, iovsLen);

        if (file && file.isStdio) {
          let totalWritten = 0;
          let text = '';
          for (const { ptr, len } of iovecs) {
            if (len > 0) {
              text += this.readStr(ptr, len);
              totalWritten += len;
            }
          }
          view.setUint32(nwrittenOut, totalWritten, true);
          if (fd === 1 || file.fd === 1) this.stdout(text);
          else this.stderr(text);
          return ESUCCESS;
        }

        if (!file || file.isDir || !file.canWrite) return EBADF;

        if (file.isCharDev) {
          let totalWritten = 0;
          for (const { len } of iovecs) {
            if (len > 0) totalWritten += len;
          }
          view.setUint32(nwrittenOut, totalWritten, true);
          return ESUCCESS;
        }

        if (this.vfsAdapter.isReadOnly(file.path)) return EROFS;

        let data = this.vfsAdapter.readFile(file.path);
        const u8 = this.memU8();
        let totalWritten = 0;

        for (const { ptr, len } of iovecs) {
          if (len <= 0) continue;
          if (file.isAppend) {
            file.cursor = data.length;
          }
          const needed = file.cursor + len;
          if (needed > data.length) {
            const nextData = new Uint8Array(needed);
            nextData.set(data);
            data = nextData;
          }
          data.set(u8.subarray(ptr, ptr + len), file.cursor);
          file.cursor += len;
          totalWritten += len;
        }

        this._writeFileAndTrack(file.path, data);
        view.setUint32(nwrittenOut, totalWritten, true);
        return ESUCCESS;
      },

      fd_pwrite: (fd, iovsPtr, iovsLen, offset, nwrittenOut) => {
        const view = this.memView();
        const file = this.openFiles.get(fd);
        if (!file || file.isDir || !file.canWrite) return EBADF;

        const iovecs = this._readIovecs(view, iovsPtr, iovsLen);
        if (file.isCharDev) {
          let totalWritten = 0;
          for (const { len } of iovecs) {
            if (len > 0) totalWritten += len;
          }
          view.setUint32(nwrittenOut, totalWritten, true);
          return ESUCCESS;
        }

        if (this.vfsAdapter.isReadOnly(file.path)) return EROFS;

        let pos = Number(offset);
        if (pos < 0) return EINVAL;

        let data = this.vfsAdapter.readFile(file.path);
        const u8 = this.memU8();
        let totalWritten = 0;

        for (const { ptr, len } of iovecs) {
          if (len <= 0) continue;
          const needed = pos + len;
          if (needed > data.length) {
            const nextData = new Uint8Array(needed);
            nextData.set(data);
            data = nextData;
          }
          data.set(u8.subarray(ptr, ptr + len), pos);
          pos += len;
          totalWritten += len;
        }

        this._writeFileAndTrack(file.path, data);
        view.setUint32(nwrittenOut, totalWritten, true);
        return ESUCCESS;
      },

      fd_seek: (fd, offset, whence, newoffsetOut) => {
        if (fd === 0 || fd === 1 || fd === 2) return ESUCCESS;
        const file = this.openFiles.get(fd);
        if (!file || file.isDir) return EBADF;

        const view = this.memView();
        if (file.isCharDev) {
          view.setBigUint64(newoffsetOut, 0n, true);
          return ESUCCESS;
        }

        const data = this.vfsAdapter.readFile(file.path);
        const offNum = Number(offset);
        let target = file.cursor;

        if (whence === WHENCE_SET) target = offNum;
        else if (whence === WHENCE_CUR) target = file.cursor + offNum;
        else if (whence === WHENCE_END) target = data.length + offNum;
        else return EINVAL;

        if (target < 0) return EINVAL;

        file.cursor = target;
        view.setBigUint64(newoffsetOut, BigInt(file.cursor), true);
        return ESUCCESS;
      },

      fd_tell: (fd, offsetOut) => {
        const file = this.openFiles.get(fd);
        if (!file || file.isDir) return EBADF;
        const view = this.memView();
        view.setBigUint64(offsetOut, file.isCharDev ? 0n : BigInt(file.cursor), true);
        return ESUCCESS;
      },

      fd_sync: (fd) => {
        const file = this.openFiles.get(fd);
        if (file && !file.isCharDev && !file.isStdio && !file.isDir && this.onFileSync) {
          const data = this.vfsAdapter.readFile(file.path);
          try {
            this.onFileSync(file.path, data);
          } catch {}
        }
        return ESUCCESS;
      },

      fd_datasync: (fd) => wasi.fd_sync(fd),
      fd_allocate: () => ESUCCESS,
      fd_advise: () => ESUCCESS,

      fd_renumber: (fromFd, toFd) => {
        if (!this.openFiles.has(fromFd)) return EBADF;
        if (fromFd === toFd) return ESUCCESS;
        if (this.openFiles.has(toFd)) {
          wasi.fd_close(toFd);
        }
        const entry = this.openFiles.get(fromFd);
        this.openFiles.delete(fromFd);
        this._openEntry({ ...entry, fd: toFd });
        return ESUCCESS;
      },

      fd_readdir: (fd, buf, bufLen, cookie, nwrittenOut) => {
        let dirPath = null;
        const preopen = this._getPreopen(fd);
        if (preopen) {
          dirPath = preopen.path;
        } else {
          const entry = this.openFiles.get(fd);
          if (entry && entry.isDir) {
            dirPath = entry.path;
          }
        }
        if (!dirPath) return EBADF;

        const entries = this._readDirWithDevices(dirPath);
        const cookieIndex = Number(cookie);
        const view = this.memView();
        const u8 = this.memU8();
        let written = 0;

        for (let i = cookieIndex; i < entries.length; i++) {
          const entry = entries[i];
          const nameBytes = textEncoder.encode(entry.name);
          const entryLen = 24 + nameBytes.length;
          if (written + entryLen > bufLen) break;

          const base = buf + written;
          u8.fill(0, base, base + 24);
          view.setBigUint64(base, BigInt(i + 1), true); // d_next
          const childPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
          view.setBigUint64(base + 8, this._getInode(childPath), true); // d_ino
          view.setUint32(base + 16, nameBytes.length, true); // d_namlen
          const dType = entry.isCharDev
            ? FILETYPE_CHARACTER_DEVICE
            : entry.isDir
              ? FILETYPE_DIRECTORY
              : FILETYPE_REGULAR_FILE;
          view.setUint8(base + 20, dType); // d_type

          u8.set(nameBytes, base + 24);
          written += entryLen;
        }

        view.setUint32(nwrittenOut, written, true);
        return ESUCCESS;
      },

      path_unlink_file: (dirfd, pathPtr, pathLen) => {
        const pathStr = this.readStr(pathPtr, pathLen);
        const fullPath = this.resolvePath(dirfd, pathStr);
        if (this.vfsAdapter.isReadOnly(fullPath)) return EROFS;
        if (this.vfsAdapter.isDir(fullPath)) return EISDIR;
        if (!this.vfsAdapter.exists(fullPath)) return ENOENT;
        try {
          this._removeFileAndTrack(fullPath);
          return ESUCCESS;
        } catch (err) {
          return VfsAdapter.mapErrorToErrno(err, EPERM);
        }
      },

      path_remove_directory: (dirfd, pathPtr, pathLen) => {
        const pathStr = this.readStr(pathPtr, pathLen);
        const fullPath = this.resolvePath(dirfd, pathStr);
        if (this.vfsAdapter.isReadOnly(fullPath)) return EROFS;
        if (!this.vfsAdapter.isDir(fullPath)) {
          return this.vfsAdapter.exists(fullPath) ? ENOTDIR : ENOENT;
        }
        try {
          this.vfsAdapter.removeDir(fullPath);
          this.deletedFiles.add(fullPath);
          if (this.onFileDelete) {
            try {
              this.onFileDelete(fullPath);
            } catch {}
          }
          return ESUCCESS;
        } catch (err) {
          return VfsAdapter.mapErrorToErrno(err, EPERM);
        }
      },

      path_create_directory: (dirfd, pathPtr, pathLen) => {
        const pathStr = this.readStr(pathPtr, pathLen);
        const fullPath = this.resolvePath(dirfd, pathStr);
        if (this.vfsAdapter.isReadOnly(fullPath)) return EROFS;
        if (this.vfsAdapter.exists(fullPath) || this.vfsAdapter.isDir(fullPath)) {
          return EEXIST;
        }
        try {
          this.vfsAdapter.mkdir(fullPath, false);
          return ESUCCESS;
        } catch (err) {
          return VfsAdapter.mapErrorToErrno(err, EPERM);
        }
      },

      path_rename: (oldDirfd, oldPathPtr, oldPathLen, newDirfd, newPathPtr, newPathLen) => {
        const oldStr = this.readStr(oldPathPtr, oldPathLen);
        const newStr = this.readStr(newPathPtr, newPathLen);
        const oldFull = this.resolvePath(oldDirfd, oldStr);
        const newFull = this.resolvePath(newDirfd, newStr);

        if (this.vfsAdapter.isReadOnly(oldFull) || this.vfsAdapter.isReadOnly(newFull)) {
          return EROFS;
        }
        if (!this.vfsAdapter.exists(oldFull) && !this.vfsAdapter.isDir(oldFull)) {
          return ENOENT;
        }

        try {
          const wasDir = this.vfsAdapter.isDir(oldFull);
          this.vfsAdapter.rename(oldFull, newFull);
          this.deletedFiles.add(oldFull);
          this.changedFiles.delete(oldFull);
          if (this.onFileDelete) {
            try {
              this.onFileDelete(oldFull);
            } catch {}
          }
          if (!wasDir && this.vfsAdapter.exists(newFull)) {
            const bytes = this.vfsAdapter.readFile(newFull);
            this.changedFiles.set(newFull, bytes);
            if (this.onFileSync) {
              try {
                this.onFileSync(newFull, bytes);
              } catch {}
            }
          }
          return ESUCCESS;
        } catch (err) {
          return VfsAdapter.mapErrorToErrno(err, EEXIST);
        }
      },

      path_readlink: () => ENOSYS,
      path_symlink: () => ENOSYS,
      path_link: () => ENOSYS,

      environ_sizes_get: (countOut, sizeOut) => {
        const view = this.memView();
        const keys = Object.keys(this.environ);
        let totalBytes = 0;
        for (const k of keys) {
          totalBytes += textEncoder.encode(`${k}=${this.environ[k]}`).length + 1;
        }
        view.setUint32(countOut, keys.length, true);
        view.setUint32(sizeOut, totalBytes, true);
        return ESUCCESS;
      },

      environ_get: (ptrs, buf) => {
        const view = this.memView();
        const u8 = this.memU8();
        const keys = Object.keys(this.environ);
        let b = buf;
        let p = ptrs;
        for (const k of keys) {
          view.setUint32(p, b, true);
          p += 4;
          const bytes = textEncoder.encode(`${k}=${this.environ[k]}`);
          u8.set(bytes, b);
          b += bytes.length;
          u8[b++] = 0;
        }
        return ESUCCESS;
      },

      args_sizes_get: (argcOut, sizeOut) => {
        const view = this.memView();
        let totalBytes = 0;
        for (const arg of this.argv) {
          totalBytes += textEncoder.encode(String(arg)).length + 1;
        }
        view.setUint32(argcOut, this.argv.length, true);
        view.setUint32(sizeOut, totalBytes, true);
        return ESUCCESS;
      },

      args_get: (ptrs, buf) => {
        const view = this.memView();
        const u8 = this.memU8();
        let b = buf;
        let p = ptrs;
        for (const arg of this.argv) {
          view.setUint32(p, b, true);
          p += 4;
          const bytes = textEncoder.encode(String(arg));
          u8.set(bytes, b);
          b += bytes.length;
          u8[b++] = 0;
        }
        return ESUCCESS;
      },

      clock_time_get: (clockId, precision, timeOut) => {
        const view = this.memView();
        let nowNs;
        if (clockId === CLOCKID_MONOTONIC && typeof performance !== 'undefined' && typeof performance.now === 'function') {
          nowNs = BigInt(Math.floor(performance.now() * 1e6));
        } else {
          nowNs = BigInt(Date.now()) * 1000000n;
        }
        view.setBigUint64(timeOut, nowNs, true);
        return ESUCCESS;
      },

      clock_res_get: (_clockId, resOut) => {
        this.memView().setBigUint64(resOut, 1000n, true);
        return ESUCCESS;
      },

      random_get: (buf, len) => {
        const u8 = this.memU8();
        const isShared = HAS_SAB && u8.buffer instanceof SharedArrayBuffer;
        const CHUNK = 65536;
        let offset = 0;
        while (offset < len) {
          const size = Math.min(CHUNK, len - offset);
          if (isShared) {
            const tmp = new Uint8Array(size);
            crypto.getRandomValues(tmp);
            u8.set(tmp, buf + offset);
          } else {
            crypto.getRandomValues(u8.subarray(buf + offset, buf + offset + size));
          }
          offset += size;
        }
        return ESUCCESS;
      },

      poll_oneoff: (inPtr, outPtr, nsubscriptions, neventsOut) => {
        const view = this.memView();
        let nevents = 0;
        let maxSleepMs = 0;

        for (let i = 0; i < nsubscriptions; i++) {
          const subPtr = inPtr + i * 48;
          const userdata = view.getBigUint64(subPtr, true);
          const tag = view.getUint8(subPtr + 8);

          if (tag === EVENTTYPE_CLOCK) {
            const timeout = view.getBigUint64(subPtr + 24, true);
            const flags = view.getUint16(subPtr + 40, true);

            let waitMs = 0;
            if ((flags & SUBCLOCKFLAGS_ABSTIME) !== 0) {
              const nowNs = BigInt(Date.now()) * 1000000n;
              if (timeout > nowNs) {
                waitMs = Number((timeout - nowNs) / 1000000n);
              }
            } else {
              waitMs = Number(timeout / 1000000n);
            }
            if (waitMs > maxSleepMs) maxSleepMs = waitMs;

            const evtPtr = outPtr + nevents * 32;
            view.setBigUint64(evtPtr, userdata, true);
            view.setUint16(evtPtr + 8, ESUCCESS, true);
            view.setUint8(evtPtr + 10, EVENTTYPE_CLOCK);
            nevents++;
          } else {
            const evtPtr = outPtr + nevents * 32;
            view.setBigUint64(evtPtr, userdata, true);
            view.setUint16(evtPtr + 8, ESUCCESS, true);
            view.setUint8(evtPtr + 10, tag);
            nevents++;
          }
        }

        if (maxSleepMs > 0) {
          const clampedMs = Math.max(1, Math.min(maxSleepMs, 60000));
          let slept = false;
          if (HAS_SAB) {
            try {
              if (!this._sleepSyncBuffer) {
                this._sleepSyncBuffer = new Int32Array(new SharedArrayBuffer(4));
              }
              Atomics.wait(this._sleepSyncBuffer, 0, 0, clampedMs);
              slept = true;
            } catch {}
          }
          if (!slept) {
            // Bounded busy-wait fallback for non-isolated or main-thread contexts
            const fallbackMs = Math.min(clampedMs, 50);
            const start = Date.now();
            while (Date.now() - start < fallbackMs) {}
          }
        }

        view.setUint32(neventsOut, nevents, true);
        return ESUCCESS;
      },

      sched_yield: () => ESUCCESS,
    };

    if (this.customFsImports && typeof this.customFsImports === 'object') {
      Object.assign(wasi, this.customFsImports);
    }

    const wrapped = typeof this.wasiWrapper === 'function' ? this.wasiWrapper(wasi, this) : wasi;
    const fallbackCode = this.strictStubs ? ENOSYS : ESUCCESS;

    return new Proxy(wrapped, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => fallbackCode;
      },
    });
  }

  /**
   * Builds the full WebAssembly import object `{ wasi_snapshot_preview1, wasi_unstable, env }`.
   * @param {Record<string, Function>} [customEnv={}]
   * @returns {{ wasi_snapshot_preview1: object, wasi_unstable: object, env: object }}
   */
  createImportObject(customEnv = {}) {
    const wasi = this.getImports();
    const providerEnv = typeof this.envProvider === 'function' ? (this.envProvider(this) || {}) : {};
    const mergedEnv = {
      ...providerEnv,
      ...(customEnv || {}),
    };

    return {
      wasi_snapshot_preview1: wasi,
      wasi_unstable: wasi,
      env: new Proxy(mergedEnv, {
        get(target, prop) {
          if (prop in target) return target[prop];
          return () => 0;
        },
      }),
    };
  }

  /**
   * Alias for `createImportObject()` for WASI API symmetry.
   * @param {Record<string, Function>} [customEnv={}]
   */
  getImportObject(customEnv = {}) {
    return this.createImportObject(customEnv);
  }
}
