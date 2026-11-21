import assert from 'node:assert/strict';
import {
  WasiHost,
  ProcExit,
  ESUCCESS,
  ENOSYS,
  EVENTTYPE_CLOCK,
  EVENTTYPE_FD_READ,
  CLOCKID_REALTIME,
  CLOCKID_MONOTONIC,
} from '../src/index.js';

function createTestMemory(pages = 1) {
  return new WebAssembly.Memory({ initial: pages, maximum: pages });
}

function writeCString(mem, offset, str) {
  const bytes = new TextEncoder().encode(str);
  const u8 = new Uint8Array(mem.buffer);
  u8.set(bytes, offset);
  u8[offset + bytes.length] = 0;
  return bytes.length;
}

function readCString(mem, offset) {
  const u8 = new Uint8Array(mem.buffer);
  let end = offset;
  while (end < u8.length && u8[end] !== 0) end++;
  return new TextDecoder().decode(u8.subarray(offset, end));
}

// 1. Language-neutral defaults
{
  const host = new WasiHost();
  assert.equal(host.cwd, '/');
  assert.deepEqual(host.argv, ['wasm']);
  assert.deepEqual(host.environ, { HOME: '/', PWD: '/' });
  assert.equal(host.systemDirs.has('/dev'), true);
  assert.equal(host.systemDirs.has('/usr'), false);
  assert.equal(host.openFiles.has(0), true);
  assert.equal(host.openFiles.has(1), true);
  assert.equal(host.openFiles.has(2), true);
}

// 2. allocateFd uniqueness across consecutive calls and minFd
{
  const host = new WasiHost({ nextFd: 10 });
  const fd1 = host.allocateFd();
  const fd2 = host.allocateFd();
  const fd3 = host.allocateFd(25);
  const fd4 = host.allocateFd(25);
  assert.equal(fd1, 10);
  assert.equal(fd2, 11);
  assert.equal(fd3, 25);
  assert.equal(fd4, 26);
}

// 3. ProcExit carries code and mutation sets
{
  const host = new WasiHost({ cwd: '/workspace', getMemory: createTestMemory() });
  const wasi = host.getImports();
  assert.throws(
    () => wasi.proc_exit(9),
    (err) => err instanceof ProcExit && err.code === 9 && err.changedFiles === host.changedFiles && err.deletedFiles === host.deletedFiles
  );
}

// 4. createImportObject, wasiWrapper, envProvider, and strictStubs
{
  let wrapperCalled = false;
  const host = new WasiHost({
    wasiWrapper: (imports, h) => {
      wrapperCalled = true;
      assert.equal(h, host);
      return { ...imports, custom_wrapped: () => 77 };
    },
    envProvider: () => ({ from_provider: () => 11, override_me: () => 22 }),
    strictStubs: true,
  });

  const obj = host.createImportObject({ override_me: () => 33, custom_fn: () => 44 });
  assert.equal(wrapperCalled, true);
  assert.equal(obj.wasi_snapshot_preview1, obj.wasi_unstable);
  assert.equal(obj.wasi_snapshot_preview1.custom_wrapped(), 77);
  assert.equal(obj.wasi_snapshot_preview1.unknown_wasi_call(), ENOSYS);
  assert.equal(obj.env.from_provider(), 11);
  assert.equal(obj.env.override_me(), 33);
  assert.equal(obj.env.custom_fn(), 44);
  assert.equal(obj.env.unknown_env_call(), 0);
}

// 5. resolvePath behavior (preopens, cwd fallback, /dev/* preservation)
{
  const vfs = new Map([
    ['/workspace/script.py', 'print(1)'],
    ['/etc/config', 'ok'],
  ]);
  const host = new WasiHost({ vfs, cwd: '/workspace' });
  assert.equal(host.resolvePath(3, '.'), '/workspace');
  assert.equal(host.resolvePath(3, 'script.py'), '/workspace/script.py');
  assert.equal(host.resolvePath(4, 'etc/config'), '/etc/config');
  assert.equal(host.resolvePath(4, 'script.py'), '/workspace/script.py');
  assert.equal(host.resolvePath(4, 'dev/null'), '/dev/null');
  assert.equal(host.resolvePath(4, 'dev/zero'), '/dev/zero');
  assert.equal(host.resolvePath(3, '../etc/config'), '/etc/config');
}

// 6. args_sizes_get, args_get, environ_sizes_get, environ_get with UTF-8
{
  const mem = createTestMemory();
  const host = new WasiHost({
    argv: ['py', 'héllo.py'],
    environ: { GREET: 'café' },
    getMemory: mem,
  });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  assert.equal(wasi.args_sizes_get(0, 4), ESUCCESS);
  const argc = view.getUint32(0, true);
  const argBufSize = view.getUint32(4, true);
  assert.equal(argc, 2);
  // 'py\0' (3) + 'héllo.py\0' (10 bytes in UTF-8) = 13
  assert.equal(argBufSize, 13);

  assert.equal(wasi.args_get(16, 64), ESUCCESS);
  assert.equal(readCString(mem, view.getUint32(16, true)), 'py');
  assert.equal(readCString(mem, view.getUint32(20, true)), 'héllo.py');

  assert.equal(wasi.environ_sizes_get(0, 4), ESUCCESS);
  const envCount = view.getUint32(0, true);
  const envSize = view.getUint32(4, true);
  assert.equal(envCount, 3); // HOME, PWD, GREET
  assert.equal(wasi.environ_get(128, 256), ESUCCESS);
  const envEntries = [];
  for (let i = 0; i < envCount; i++) {
    envEntries.push(readCString(mem, view.getUint32(128 + i * 4, true)));
  }
  assert.ok(envEntries.includes('GREET=café'));
  assert.equal(
    envEntries.reduce((acc, s) => acc + new TextEncoder().encode(s).length + 1, 0),
    envSize
  );
}

// 7. clock_time_get, clock_res_get, random_get (>65536 chunking), poll_oneoff
{
  const mem = createTestMemory(3); // 192KB
  const host = new WasiHost({ getMemory: mem });
  const wasi = host.getImports();
  const view = new DataView(mem.buffer);

  assert.equal(wasi.clock_res_get(CLOCKID_REALTIME, 8), ESUCCESS);
  assert.equal(view.getBigUint64(8, true), 1000n);

  assert.equal(wasi.clock_time_get(CLOCKID_REALTIME, 0n, 16), ESUCCESS);
  assert.ok(view.getBigUint64(16, true) > 0n);

  assert.equal(wasi.clock_time_get(CLOCKID_MONOTONIC, 0n, 24), ESUCCESS);
  assert.ok(view.getBigUint64(24, true) >= 0n);

  // Chunked random_get > 65536 bytes
  const randPtr = 4096;
  const randLen = 70000;
  assert.equal(wasi.random_get(randPtr, randLen), ESUCCESS);
  const sample = new Uint8Array(mem.buffer, randPtr, randLen);
  let nonZero = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) nonZero++;
  }
  assert.ok(nonZero > 60000);

  // poll_oneoff with 1 clock (2ms) and 1 fd_read
  const subPtr = 128;
  const outPtr = 512;
  new Uint8Array(mem.buffer).fill(0, subPtr, subPtr + 96);
  view.setBigUint64(subPtr, 101n, true);
  view.setUint8(subPtr + 8, EVENTTYPE_CLOCK);
  view.setBigUint64(subPtr + 24, 2_000_000n, true); // 2ms

  view.setBigUint64(subPtr + 48, 202n, true);
  view.setUint8(subPtr + 48 + 8, EVENTTYPE_FD_READ);

  assert.equal(wasi.poll_oneoff(subPtr, outPtr, 2, 1024), ESUCCESS);
  assert.equal(view.getUint32(1024, true), 2);
  assert.equal(view.getBigUint64(outPtr, true), 101n);
  assert.equal(view.getUint8(outPtr + 10), EVENTTYPE_CLOCK);
  assert.equal(view.getBigUint64(outPtr + 32, true), 202n);
  assert.equal(view.getUint8(outPtr + 32 + 10), EVENTTYPE_FD_READ);
}

// 8. readStr helper over SharedArrayBuffer memory
{
  const sharedMem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  writeCString(sharedMem, 100, 'shared-utf8-✓');
  const host = new WasiHost({ getMemory: sharedMem });
  assert.equal(host.readStr(100), 'shared-utf8-✓');
  assert.equal(host.readStr(100, 11), 'shared-utf8');
  assert.equal(host.getImports().random_get(200, 64), ESUCCESS);
}

console.log('test/wasi-host.test.js: ALL PASSED');
