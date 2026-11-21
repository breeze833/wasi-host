import assert from 'node:assert/strict';
import {
  WasiHost,
  ESUCCESS,
  ENOTDIR,
  O_DIRECTORY,
  FILETYPE_CHARACTER_DEVICE,
  FILETYPE_REGULAR_FILE,
  RIGHTS_TTY,
  WHENCE_SET,
} from '../src/index.js';

function createMem() {
  return new WebAssembly.Memory({ initial: 1, maximum: 1 });
}

function writeStr(mem, ptr, str) {
  const bytes = new TextEncoder().encode(str);
  new Uint8Array(mem.buffer).set(bytes, ptr);
  return bytes.length;
}

// 1. /dev/null & /dev/zero behavior without VFS pollution
{
  const vfs = new Map();
  const mem = createMem();
  const host = new WasiHost({ vfs, cwd: '/workspace', getMemory: mem });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  // Stat /dev/null and /dev/zero -> CHARACTER_DEVICE
  const nullLen = writeStr(mem, 64, '/dev/null');
  assert.equal(wasi.path_filestat_get(4, 0, 64, nullLen, 256), ESUCCESS);
  assert.equal(view.getUint8(256 + 16), FILETYPE_CHARACTER_DEVICE);
  assert.equal(view.getBigUint64(256 + 32, true), 0n);

  // O_DIRECTORY on /dev/null -> ENOTDIR
  assert.equal(wasi.path_open(4, 0, 64, nullLen, O_DIRECTORY, 0n, 0n, 0, 128), ENOTDIR);

  // Open /dev/null: writes discard, reads return 0
  assert.equal(wasi.path_open(4, 0, 64, nullLen, 0, 0n, 0n, 0, 128), ESUCCESS);
  const nullFd = view.getUint32(128, true);

  const payloadLen = writeStr(mem, 512, 'discard-me');
  view.setUint32(300, 512, true);
  view.setUint32(304, payloadLen, true);
  assert.equal(wasi.fd_write(nullFd, 300, 1, 320), ESUCCESS);
  assert.equal(view.getUint32(320, true), payloadLen);

  view.setUint32(300, 600, true);
  view.setUint32(304, 16, true);
  assert.equal(wasi.fd_read(nullFd, 300, 1, 320), ESUCCESS);
  assert.equal(view.getUint32(320, true), 0);

  assert.equal(wasi.fd_seek(nullFd, 100n, WHENCE_SET, 328), ESUCCESS);
  assert.equal(view.getBigUint64(328, true), 0n);
  assert.equal(wasi.fd_close(nullFd), ESUCCESS);

  // Open /dev/zero: reads fill 0x00 across multiple iovecs
  const zeroLen = writeStr(mem, 64, 'dev/zero');
  assert.equal(wasi.path_open(4, 0, 64, zeroLen, 0, 0n, 0n, 0, 128), ESUCCESS);
  const zeroFd = view.getUint32(128, true);

  new Uint8Array(mem.buffer).fill(0xff, 700, 720);
  view.setUint32(300, 700, true);
  view.setUint32(304, 8, true);
  view.setUint32(308, 710, true);
  view.setUint32(312, 6, true);
  assert.equal(wasi.fd_read(zeroFd, 300, 2, 320), ESUCCESS);
  assert.equal(view.getUint32(320, true), 14);
  assert.deepEqual(Array.from(new Uint8Array(mem.buffer, 700, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(new Uint8Array(mem.buffer, 710, 6)), [0, 0, 0, 0, 0, 0]);
  assert.equal(wasi.fd_close(zeroFd), ESUCCESS);

  // Ensure neither /dev/null nor /dev/zero leaked into Map VFS
  assert.equal(vfs.size, 0);
}

// 2. fd_readdir('/dev') exposes virtual null and zero
{
  const mem = createMem();
  const host = new WasiHost({ getMemory: mem });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  const devLen = writeStr(mem, 64, '/dev');
  assert.equal(wasi.path_open(4, 0, 64, devLen, O_DIRECTORY, 0n, 0n, 0, 128), ESUCCESS);
  const devFd = view.getUint32(128, true);

  assert.equal(wasi.fd_readdir(devFd, 1024, 512, 0n, 256), ESUCCESS);
  const bufUsed = view.getUint32(256, true);
  const names = [];
  let offset = 0;
  while (offset < bufUsed) {
    const namelen = view.getUint32(1024 + offset + 16, true);
    const name = new TextDecoder().decode(new Uint8Array(mem.buffer, 1024 + offset + 24, namelen));
    names.push(name);
    offset += 24 + namelen;
  }
  assert.ok(names.includes('null'));
  assert.ok(names.includes('zero'));
  assert.equal(wasi.fd_close(devFd), ESUCCESS);
}

// 3. Stdio (stdin string/callback, stdout, stderr) & TTY vs redirected fdstat
{
  const mem = createMem();
  const view = new DataView(mem.buffer);
  let out = '';
  let err = '';

  const host = new WasiHost({
    stdin: 'abc\n',
    stdout: (t) => { out += t; },
    stderr: (t) => { err += t; },
    getMemory: mem,
  });
  const wasi = host.getImports();

  // TTY fdstat for fd 0/1/2
  assert.equal(wasi.fd_fdstat_get(1, 128), ESUCCESS);
  assert.equal(view.getUint8(128), FILETYPE_CHARACTER_DEVICE);
  assert.equal(view.getBigUint64(128 + 8, true), RIGHTS_TTY);

  // Read stdin
  view.setUint32(200, 400, true);
  view.setUint32(204, 10, true);
  assert.equal(wasi.fd_read(0, 200, 1, 220), ESUCCESS);
  assert.equal(view.getUint32(220, true), 4);
  assert.equal(new TextDecoder().decode(new Uint8Array(mem.buffer, 400, 4)), 'abc\n');

  // Write stdout & stderr
  const oLen = writeStr(mem, 500, 'out!');
  view.setUint32(200, 500, true);
  view.setUint32(204, oLen, true);
  assert.equal(wasi.fd_write(1, 200, 1, 220), ESUCCESS);
  assert.equal(out, 'out!');

  const eLen = writeStr(mem, 520, 'err!');
  view.setUint32(200, 520, true);
  view.setUint32(204, eLen, true);
  assert.equal(wasi.fd_write(2, 200, 1, 220), ESUCCESS);
  assert.equal(err, 'err!');

  // Redirect fd 1 to a regular file via fd_renumber -> fd_fdstat_get reflects regular file
  const fLen = writeStr(mem, 64, '/out.txt');
  assert.equal(wasi.path_open(4, 0, 64, fLen, 1, 0n, 0n, 0, 240), ESUCCESS);
  const fileFd = view.getUint32(240, true);
  assert.equal(wasi.fd_renumber(fileFd, 1), ESUCCESS);
  assert.equal(wasi.fd_fdstat_get(1, 128), ESUCCESS);
  assert.equal(view.getUint8(128), FILETYPE_REGULAR_FILE);
}

console.log('test/devices.test.js: ALL PASSED');
