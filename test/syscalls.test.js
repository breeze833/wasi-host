import assert from 'node:assert/strict';
import {
  WasiHost,
  ESUCCESS,
  EBADF,
  EEXIST,
  EINVAL,
  EISDIR,
  ENOENT,
  ENOTEMPTY,
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  O_DIRECTORY,
  FDFLAG_APPEND,
  WHENCE_SET,
  WHENCE_CUR,
  WHENCE_END,
} from '../src/index.js';

function createMem() {
  return new WebAssembly.Memory({ initial: 1, maximum: 1 });
}

function writeStr(mem, ptr, str) {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(mem.buffer).set(bytes, ptr);
  return bytes.length;
}

// 1. path_open flags (O_CREAT, O_EXCL, O_TRUNC, FDFLAG_APPEND), fd_write, fd_pwrite, fd_read, fd_pread, fd_seek, fd_tell
{
  const vfs = new Map();
  const mem = createMem();
  const host = new WasiHost({ vfs, cwd: '/workspace', getMemory: mem });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  const pLen = writeStr(mem, 64, 'data.bin');

  // Missing without O_CREAT -> ENOENT
  assert.equal(wasi.path_open(3, 0, 64, pLen, 0, 0n, 0n, 0, 128), ENOENT);

  // Create & write "Hello"
  assert.equal(wasi.path_open(3, 0, 64, pLen, O_CREAT, 0n, 0n, 0, 128), ESUCCESS);
  const fd1 = view.getUint32(128, true);

  // O_CREAT | O_EXCL when exists -> EEXIST
  assert.equal(wasi.path_open(3, 0, 64, pLen, O_CREAT | O_EXCL, 0n, 0n, 0, 132), EEXIST);

  const helloLen = writeStr(mem, 512, 'Hello');
  view.setUint32(200, 512, true);
  view.setUint32(204, helloLen, true);
  assert.equal(wasi.fd_write(fd1, 200, 1, 220), ESUCCESS);
  assert.equal(view.getUint32(220, true), 5);

  // fd_tell -> 5
  assert.equal(wasi.fd_tell(fd1, 240), ESUCCESS);
  assert.equal(view.getBigUint64(240, true), 5n);

  // fd_pwrite at offset 1 ("a") without moving cursor (still 5)
  writeStr(mem, 520, 'a');
  view.setUint32(200, 520, true);
  view.setUint32(204, 1, true);
  assert.equal(wasi.fd_pwrite(fd1, 200, 1, 1n, 220), ESUCCESS);
  assert.equal(wasi.fd_tell(fd1, 240), ESUCCESS);
  assert.equal(view.getBigUint64(240, true), 5n);

  // fd_seek negative -> EINVAL
  assert.equal(wasi.fd_seek(fd1, -10n, WHENCE_SET, 240), EINVAL);

  // fd_seek WHENCE_SET 0 and fd_read -> "Hallo"
  assert.equal(wasi.fd_seek(fd1, 0n, WHENCE_SET, 240), ESUCCESS);
  view.setUint32(200, 600, true);
  view.setUint32(204, 10, true);
  assert.equal(wasi.fd_read(fd1, 200, 1, 220), ESUCCESS);
  assert.equal(view.getUint32(220, true), 5);
  assert.equal(new TextDecoder().decode(new Uint8Array(mem.buffer, 600, 5)), 'Hallo');

  // fd_pread at offset 2 (length 3) -> "llo" without moving cursor
  assert.equal(wasi.fd_pread(fd1, 200, 1, 2n, 220), ESUCCESS);
  assert.equal(view.getUint32(220, true), 3);
  assert.equal(new TextDecoder().decode(new Uint8Array(mem.buffer, 600, 3)), 'llo');
  assert.equal(wasi.fd_tell(fd1, 240), ESUCCESS);
  assert.equal(view.getBigUint64(240, true), 5n);

  // fd_seek WHENCE_CUR -2 -> 3, WHENCE_END -1 -> 4
  assert.equal(wasi.fd_seek(fd1, -2n, WHENCE_CUR, 240), ESUCCESS);
  assert.equal(view.getBigUint64(240, true), 3n);
  assert.equal(wasi.fd_seek(fd1, -1n, WHENCE_END, 240), ESUCCESS);
  assert.equal(view.getBigUint64(240, true), 4n);

  // fd_filestat_set_size(2) -> truncates to "Ha"
  assert.equal(wasi.fd_filestat_set_size(fd1, 2n), ESUCCESS);
  assert.equal(new TextDecoder().decode(vfs.get('/workspace/data.bin')), 'Ha');
  assert.equal(wasi.fd_close(fd1), ESUCCESS);

  // Closing again -> EBADF
  assert.equal(wasi.fd_close(fd1), EBADF);

  // Reopen with FDFLAG_APPEND and write "!" -> "Ha!"
  assert.equal(wasi.path_open(3, 0, 64, pLen, 0, 0n, 0n, FDFLAG_APPEND, 128), ESUCCESS);
  const fdAppend = view.getUint32(128, true);
  writeStr(mem, 530, '!');
  view.setUint32(200, 530, true);
  view.setUint32(204, 1, true);
  assert.equal(wasi.fd_write(fdAppend, 200, 1, 220), ESUCCESS);
  assert.equal(new TextDecoder().decode(vfs.get('/workspace/data.bin')), 'Ha!');
  assert.equal(wasi.fd_close(fdAppend), ESUCCESS);

  // Reopen with O_TRUNC -> empty
  assert.equal(wasi.path_open(3, 0, 64, pLen, O_TRUNC, 0n, 0n, 0, 128), ESUCCESS);
  assert.equal(vfs.get('/workspace/data.bin').length, 0);
  assert.equal(wasi.fd_close(view.getUint32(128, true)), ESUCCESS);
}

// 2. Directories, fd_readdir pagination, ENOTEMPTY, EISDIR
{
  const vfs = new Map();
  const mem = createMem();
  const host = new WasiHost({ vfs, cwd: '/workspace', getMemory: mem });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  const dirLen = writeStr(mem, 64, 'folder');
  assert.equal(wasi.path_create_directory(3, 64, dirLen), ESUCCESS);

  // Opening directory without O_DIRECTORY -> EISDIR
  assert.equal(wasi.path_open(3, 0, 64, dirLen, 0, 0n, 0n, 0, 128), EISDIR);

  // Unlinking directory -> EISDIR
  assert.equal(wasi.path_unlink_file(3, 64, dirLen), EISDIR);

  // Add two files inside folder
  for (const name of ['folder/alpha.txt', 'folder/beta.txt']) {
    const len = writeStr(mem, 64, name);
    assert.equal(wasi.path_open(3, 0, 64, len, O_CREAT, 0n, 0n, 0, 128), ESUCCESS);
    assert.equal(wasi.fd_close(view.getUint32(128, true)), ESUCCESS);
  }

  // Removing non-empty directory -> ENOTEMPTY
  const folderLen = writeStr(mem, 64, 'folder');
  assert.equal(wasi.path_remove_directory(3, 64, folderLen), ENOTEMPTY);

  // Paginated fd_readdir with small buffer (enough for 1 entry per call)
  assert.equal(wasi.path_open(3, 0, 64, folderLen, O_DIRECTORY, 0n, 0n, 0, 128), ESUCCESS);
  const dirFd = view.getUint32(128, true);

  const seen = [];
  let cookie = 0n;
  while (true) {
    assert.equal(wasi.fd_readdir(dirFd, 1024, 34, cookie, 256), ESUCCESS);
    const used = view.getUint32(256, true);
    if (used === 0) break;
    const nextCookie = view.getBigUint64(1024, true);
    const namelen = view.getUint32(1024 + 16, true);
    const entryName = new TextDecoder().decode(new Uint8Array(mem.buffer, 1024 + 24, namelen));
    seen.push(entryName);
    cookie = nextCookie;
  }
  assert.deepEqual(seen.sort(), ['alpha.txt', 'beta.txt']);
  assert.equal(wasi.fd_close(dirFd), ESUCCESS);

  // Clean up files and remove empty directory
  for (const name of ['folder/alpha.txt', 'folder/beta.txt']) {
    const len = writeStr(mem, 64, name);
    assert.equal(wasi.path_unlink_file(3, 64, len), ESUCCESS);
  }
  assert.equal(wasi.path_remove_directory(3, 64, folderLen), ESUCCESS);
}

console.log('test/syscalls.test.js: ALL PASSED');
