import assert from 'node:assert/strict';
import {
  WasiHost,
  VfsAdapter,
  normalizePath,
  ESUCCESS,
  EROFS,
  ENOENT,
  O_CREAT,
  O_TRUNC,
} from '../src/index.js';

function createMem() {
  return new WebAssembly.Memory({ initial: 1, maximum: 1 });
}

function writeStr(mem, ptr, str) {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(mem.buffer).set(bytes, ptr);
  return bytes.length;
}

// 1. normalizePath cases
{
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('/workspace//src/../main.py/'), '/workspace/main.py');
  assert.equal(normalizePath('a/./b/../c'), 'a/c');
  assert.equal(normalizePath('/../../a'), '/a');
}

// 2. Map & Plain Object backing via VfsAdapter
{
  const mapStore = new Map([['/workspace/a.txt', 'alpha']]);
  const adapter = new VfsAdapter(mapStore);
  assert.equal(adapter.exists('/workspace/a.txt'), true);
  assert.equal(adapter.isDir('/workspace'), true);
  assert.equal(new TextDecoder().decode(adapter.readFile('/workspace/a.txt')), 'alpha');

  adapter.writeFile('/workspace/sub/b.txt', 'beta');
  assert.equal(adapter.isDir('/workspace/sub'), true);
  const entries = adapter.readDir('/workspace').map((e) => e.name).sort();
  assert.deepEqual(entries, ['a.txt', 'sub']);

  adapter.rename('/workspace/sub/b.txt', '/workspace/sub/c.txt');
  assert.equal(adapter.exists('/workspace/sub/b.txt'), false);
  assert.equal(new TextDecoder().decode(adapter.readFile('/workspace/sub/c.txt')), 'beta');

  const objStore = { '/workspace/hello.py': 'print(42)' };
  const objAdapter = new VfsAdapter(objStore);
  assert.equal(objAdapter.exists('/workspace/hello.py'), true);
  objAdapter.removeFile('/workspace/hello.py');
  assert.equal(objAdapter.exists('/workspace/hello.py'), false);
}

// 3. OverlayVFS-style mock with EROFS, mtime, setTimes, changedFiles, deletedFiles, callbacks
{
  const files = new Map([
    ['/usr/lib/python/os.py', { isDir: false, content: new TextEncoder().encode('# os'), mtime: 1700000000000 }],
    ['/workspace/note.txt', { isDir: false, content: new TextEncoder().encode('init'), mtime: 1700000001000 }],
  ]);
  const dirs = new Set(['/', '/usr', '/usr/lib', '/usr/lib/python', '/workspace']);

  const mockOverlayVfs = {
    _isReadOnly(p) {
      return normalizePath(p).startsWith('/usr');
    },
    exists(p) {
      const n = normalizePath(p);
      return files.has(n) || dirs.has(n);
    },
    isDir(p) {
      return dirs.has(normalizePath(p));
    },
    stat(p) {
      const n = normalizePath(p);
      if (dirs.has(n)) return { isDir: true, size: 0, mtime: 1700000000000 };
      const f = files.get(n);
      return f ? { isDir: false, size: f.content.length, mtime: f.mtime } : null;
    },
    readFile(p) {
      const f = files.get(normalizePath(p));
      return f ? f.content : new Uint8Array(0);
    },
    writeFile(p, content, opts = {}) {
      const n = normalizePath(p);
      files.set(n, { isDir: false, content: new Uint8Array(content), mtime: opts.mtime || Date.now() });
    },
    mkdir(p) {
      dirs.add(normalizePath(p));
    },
    removeFile(p) {
      files.delete(normalizePath(p));
    },
    removeDir(p) {
      dirs.delete(normalizePath(p));
    },
    rename(oldP, newP) {
      const o = normalizePath(oldP);
      const n = normalizePath(newP);
      const f = files.get(o);
      if (f) {
        files.set(n, f);
        files.delete(o);
      }
    },
    setTimes(p, _atim, mtimNs) {
      const f = files.get(normalizePath(p));
      if (f) f.mtime = Number(mtimNs / 1000000n);
    },
    readDir(p) {
      const prefix = normalizePath(p) === '/' ? '/' : normalizePath(p) + '/';
      const out = [];
      for (const d of dirs) {
        if (d.startsWith(prefix)) {
          const rest = d.substring(prefix.length);
          if (rest && !rest.includes('/')) out.push({ name: rest, isDir: true });
        }
      }
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.substring(prefix.length);
          if (rest && !rest.includes('/')) out.push({ name: rest, isDir: false });
        }
      }
      return out;
    },
  };

  const synced = [];
  const deleted = [];
  const mem = createMem();
  const host = new WasiHost({
    vfs: mockOverlayVfs,
    cwd: '/workspace',
    getMemory: mem,
    onFileSync: (p, b) => synced.push([p, b.length]),
    onFileDelete: (p) => deleted.push(p),
  });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  // Read-only /usr checks -> EROFS
  const roLen = writeStr(mem, 64, '/usr/lib/python/os.py');
  assert.equal(wasi.path_open(4, 0, 64, roLen, O_CREAT | O_TRUNC, 0n, 0n, 0, 128), EROFS);
  assert.equal(wasi.path_unlink_file(4, 64, roLen), EROFS);
  assert.equal(wasi.path_filestat_set_times(4, 0, 64, roLen, 0n, 1700000099000000000n, 4), EROFS);

  const roDirLen = writeStr(mem, 64, '/usr/evil');
  assert.equal(wasi.path_create_directory(4, 64, roDirLen), EROFS);

  // Read-only open WITHOUT write rights succeeds
  assert.equal(wasi.path_open(4, 0, 64, writeStr(mem, 64, '/usr/lib/python/os.py'), 0, 2n, 0n, 0, 128), ESUCCESS);
  assert.equal(wasi.fd_close(view.getUint32(128, true)), ESUCCESS);

  // mtime preserved in path_filestat_get & updated via path_filestat_set_times
  const noteLen = writeStr(mem, 64, 'note.txt');
  assert.equal(wasi.path_filestat_get(3, 0, 64, noteLen, 256), ESUCCESS);
  assert.equal(view.getBigUint64(256 + 48, true), 1700000001000n * 1000000n);

  assert.equal(wasi.path_filestat_set_times(3, 0, 64, noteLen, 0n, 1700000123000000000n, 4), ESUCCESS);
  assert.equal(wasi.path_filestat_get(3, 0, 64, noteLen, 256), ESUCCESS);
  assert.equal(view.getBigUint64(256 + 48, true), 1700000123000000000n);

  // Create, rename, unlink tracking
  const newLen = writeStr(mem, 64, 'created.txt');
  assert.equal(wasi.path_open(3, 0, 64, newLen, O_CREAT, 0n, 0n, 0, 128), ESUCCESS);
  const fd = view.getUint32(128, true);
  assert.equal(wasi.fd_close(fd), ESUCCESS);
  assert.equal(host.changedFiles.has('/workspace/created.txt'), true);
  assert.ok(synced.some(([p]) => p === '/workspace/created.txt'));

  const renamedLen = writeStr(mem, 160, 'moved.txt');
  assert.equal(wasi.path_rename(3, 64, newLen, 3, 160, renamedLen), ESUCCESS);
  assert.equal(host.deletedFiles.has('/workspace/created.txt'), true);
  assert.equal(host.changedFiles.has('/workspace/moved.txt'), true);

  assert.equal(wasi.path_unlink_file(3, 160, renamedLen), ESUCCESS);
  assert.equal(host.deletedFiles.has('/workspace/moved.txt'), true);
  assert.ok(deleted.includes('/workspace/moved.txt'));

  const missingLen = writeStr(mem, 64, 'nope.txt');
  assert.equal(wasi.path_unlink_file(3, 64, missingLen), ENOENT);
}

console.log('test/vfs-adapter.test.js: ALL PASSED');
