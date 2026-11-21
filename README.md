# wasi-host

> Zero-dependency, language-neutral **WASI Preview 1 (`wasi_snapshot_preview1` / `wasi_unstable`) Process & Execution Host** for WebAssembly runtimes in browsers and Node.js.

[![Release](https://img.shields.io/github/v/release/breeze833/wasi-host)](https://github.com/breeze833/wasi-host/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Overview

`wasi-host` provides a pure JavaScript WASI Preview 1 host runtime capable of running any `wasm32-wasip1` binary—compilers (`clang-wasi`), language interpreters (`python-wasi`), POSIX shells (`busybox-wasi`), build tools (`make-wasi`), database engines (`sqlite-wasi`), or user-compiled programs—inside browser Web Workers, main threads, and Node.js.

It decouples process lifecycle, argument/environment passing, clocks, cryptographic randomness, polling, descriptor tables, and virtual devices from any specific language toolchain or filesystem backend.

---

## Key Features

- **Language-Neutral WASI Preview 1 Runtime**: Full `wasi_snapshot_preview1` and `wasi_unstable` syscall coverage with zero C/C++ or Python assumptions.
- **Zero Required Runtime Dependencies**: 100% vanilla ES Modules and TypedArrays.
- **Flexible VFS Backing**: Works natively with [`vfs-wasi`](https://github.com/breeze833/vfs-wasi) (`OverlayVFS` + zero-copy `SharedSysroot` + `EROFS` protection) as well as plain `Map<string, Uint8Array | string>` or object stores.
- **Virtual Character Devices**: Built-in `/dev/null` and `/dev/zero` handling without polluting the virtual filesystem.
- **Composable Host Extensions**: Clean extension hooks (`wasiWrapper`, `envProvider`, `customEnv`) for [`busybox-wasi`](https://github.com/breeze833/busybox-wasi) pipes, [`stdin-wasi`](https://github.com/breeze833/stdin-wasi) synchronous blocking stdin, [`canvas-wasi`](https://github.com/breeze833/canvas-wasi), and custom host bridges.
- **Cross-Origin Isolation & `SharedArrayBuffer` Safe**: Complies with the W3C Encoding Standard (`TextDecoder` over shared memory) and supports `Atomics.wait()` sleeping in workers with non-isolated fallbacks.
- **Mutation Tracking**: Built-in `changedFiles`, `deletedFiles`, `createdDirs`, `onFileSync`, and `onFileDelete` hooks for worker-to-main-thread synchronization.

---

## Installation

> **Note:** `wasi-host` is **not** published to the public npmjs registry. The NPM `.tgz` package is **only available on this repository's [GitHub Releases](https://github.com/breeze833/wasi-host/releases) page**.

### Install via GitHub Releases Tarball

```bash
npm install https://github.com/breeze833/wasi-host/releases/download/latest/wasi-host-0.1.0.tgz
```

Or pin a specific release tag:

```bash
npm install https://github.com/breeze833/wasi-host/releases/download/v0.1.0/wasi-host-0.1.0.tgz
```

Or add directly to your `package.json`:

```json
{
  "dependencies": {
    "wasi-host": "https://github.com/breeze833/wasi-host/releases/download/latest/wasi-host-0.1.0.tgz"
  }
}
```

---

## Quick Start

### 1. Standalone Execution with a `Map` (Node.js or Browser)

```javascript
import { WasiHost, ProcExit } from 'wasi-host';

const vfs = new Map([
  ['/workspace/hello.txt', new TextEncoder().encode('Hello from WASI!\n')],
]);

let memory = null;
const host = new WasiHost({
  vfs,
  cwd: '/workspace',
  argv: ['my-app', 'hello.txt'],
  environ: { LANG: 'en_US.UTF-8' },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  getMemory: () => memory,
});

const imports = host.createImportObject();
const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
memory = instance.exports.memory;

try {
  instance.exports._start();
} catch (err) {
  if (err instanceof ProcExit) {
    console.log('Exit code:', err.code);
  } else {
    throw err;
  }
}
```

### 2. Composing with `vfs-wasi` and `stdin-wasi` in a Web Worker

```javascript
import { WasiHost, ProcExit } from 'wasi-host';
import { OverlayVFS } from 'vfs-wasi';
import { createStdinReader } from 'stdin-wasi/worker';

const vfs = new OverlayVFS({
  sharedSysroot: sharedSysrootBuffer,
  workingDir: '/workspace',
});

let memory = null;
const host = new WasiHost({
  vfs,
  cwd: '/workspace',
  argv: ['python3', 'main.py'],
  environ: { PYTHONHOME: '/usr/local', HOME: '/workspace', PWD: '/workspace' },
  stdin: createStdinReader({
    sharedBuffer: stdinSharedBuffer,
    getMemory: () => memory,
    notifyHost: () => self.postMessage({ type: 'stdin_request' }),
  }),
  stdout: (text) => self.postMessage({ type: 'stdout', data: text }),
  stderr: (text) => self.postMessage({ type: 'stderr', data: text }),
  getMemory: () => memory,
  onFileSync: (path, data) => self.postMessage({ type: 'file_sync', path, data }),
  onFileDelete: (path) => self.postMessage({ type: 'file_delete', path }),
});

const { instance } = await WebAssembly.instantiate(pythonWasmBytes, host.createImportObject());
memory = instance.exports.memory;

try {
  instance.exports._start();
} catch (err) {
  if (!(err instanceof ProcExit)) throw err;
}
```

### 3. Composing with `busybox-wasi` Pipes

```javascript
import { WasiHost } from 'wasi-host';
import { createBusyboxBridge, wrapWasiPipes } from 'busybox-wasi/host';

const host = new WasiHost({
  vfs,
  cwd: '/workspace',
  argv: ['sh', '-c', 'ls | wc -l'],
  wasiWrapper: (imports, h) => wrapWasiPipes(imports, h),
  envProvider: (h) => createBusyboxBridge(h),
});
```

---

## API Summary

- `new WasiHost(options)` — Configures VFS backing, `cwd`, `argv`, `environ`, `preopens`, `systemDirs`, stdio handlers, memory getter, mutation callbacks, `strictStubs`, and extension hooks (`wasiWrapper`, `envProvider`).
- `host.getImports()` — Returns the `wasi_snapshot_preview1` syscall object (with optional `wasiWrapper`).
- `host.createImportObject(customEnv)` / `host.getImportObject(customEnv)` — Returns `{ wasi_snapshot_preview1, wasi_unstable, env }` ready for `WebAssembly.instantiate`.
- `host.setMemory(memoryOrGetter)` / `host.mem()` / `host.memU8()` / `host.memView()` — Binds and accesses WebAssembly linear memory safely.
- `host.allocateFd(minFd)` / `host.openFiles` — Standardized FD table contract for pipe/shell integrations.
- `VfsAdapter` — Unified VFS abstraction over `OverlayVFS`, `Map`, and plain object stores (`wasi-host/vfs-adapter`).
- `ProcExit` — Error thrown by `proc_exit(code)` carrying `code`, `changedFiles`, and `deletedFiles`.
- `normalizePath(path)` — POSIX path normalization helper.

See [SPEC.md](SPEC.md) for the complete syscall table, descriptor contract, and ABI details.

---

## Development & Testing

```bash
# Run automated unit, syscall, and Wasm reference tests
npm test

# Run standalone Node.js reference runner
npm run test:host

# Start local interactive COOP/COEP browser demo server
npm run demo

# Pack release tarball into dist/
npm run pack
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
