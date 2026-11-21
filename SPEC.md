# SPEC.md: Architectural Specification for `wasi-host`

---

## 1. Architectural Ground Truth & Mission Statement

`wasi-host` is a language-neutral, zero-dependency **WASI Preview 1 (`wasi_snapshot_preview1` / `wasi_unstable`) Process & Execution Host** for WebAssembly runtimes in modern browsers (Main Thread & Web Workers) and Node.js.

Designed as the shared execution layer for browser IDEs (such as [`wasm-c-ide`](https://github.com/breeze833/wasm-c-ide) and future `wasm-python-ide`) and standalone WASI packages (`clang-wasi`, `python-wasi`, `busybox-wasi`, `make-wasi`, `sqlite-wasi`), `wasi-host` provides standardized WASI Preview 1 process, clock, random, polling, descriptor, and virtual filesystem host bindings without coupling to any specific compiler, language runtime, or shell.

---

## 2. Motivation & Architectural Problem Statement

Previously, the `WasiHost` implementation lived inside `clang-wasi/host`, creating three structural problems across the ecosystem:

1. **Language & Toolchain Coupling**: Non-C runtimes (such as Python, SQLite, GNU Make, or BusyBox) had to depend transitively on `clang-wasi` solely to obtain a WASI Preview 1 host, inheriting C-centric defaults (`./a.out`, `/usr/include`, `/usr/lib`).
2. **Duplicate Filesystem Implementations**: Both `clang-wasi/src/wasi-host.js` and `vfs-wasi/src/wasi-fs.js` maintained separate WASI Preview 1 filesystem implementations, leading downstream consumers (e.g., `wasm-c-ide/src/vfs/wasi-host.js`) to monkey-patch syscall overrides for `EROFS`, `mtime`, and mutation tracking.
3. **Undocumented Extension Contracts**: Shell bridges (`busybox-wasi/host`) and interactive I/O (`stdin-wasi`) relied on internal host properties (`openFiles`, `allocateFd`, `changedFiles`) without a formal specification.

`wasi-host` resolves these issues by establishing a single, language-agnostic WASI Preview 1 host package with clean VFS composition and documented extension hooks.

---

## 3. Target Platform & Core Invariants

- **Target ABI**: WebAssembly 32-bit WASI Preview 1 (`wasi_snapshot_preview1` and `wasi_unstable` alias).
- **Host Environments**:
  - Modern browsers (Main Thread and Web Workers, both COOP/COEP cross-origin isolated with `SharedArrayBuffer` and non-isolated `ArrayBuffer` fallbacks).
  - Node.js (`>= 18`) using standard ES Modules.
- **Zero Required Runtime Dependencies**: Pure vanilla JavaScript / TypedArrays with zero mandatory external npm dependencies.
- **Language Neutrality**: Zero hardcoded C/C++ or Python paths, binary names, or compiler defaults.
- **VFS Flexibility & `vfs-wasi` Composition**:
  - Integrates seamlessly with `vfs-wasi` (`OverlayVFS` / `createWasiFsImports`) for Two-Tier Overlay VFS, zero-copy `SharedSysroot`, `EROFS` protection, and `mtime` persistence.
  - Also supports standalone `Map<string, Uint8Array | string>` or plain JavaScript object stores out of the box.
- **W3C `TextDecoder` SharedArrayBuffer Compliance**: Any string decoded from WebAssembly linear memory backed by a `SharedArrayBuffer` MUST be copied to an unshared `Uint8Array` before passing to `TextDecoder.decode()`.
- **Pure WASI Core + Explicit Extension Hooks**: Shell pipe wrappers (`busybox-wasi`), synchronous stdin (`stdin-wasi`), and custom `env` bridges (`canvas-wasi`, `raylib-wasi`, `make-wasi`) attach via explicit constructor options rather than being baked into core syscalls.

---

## 4. Repository Topology

```
wasi-host/
├── .github/
│   └── workflows/
│       └── release.yml        # Automated CI test, npm pack, v* release & rolling latest tag
├── .gitignore                 # Excludes dist/, node_modules/, and *.tgz build artifacts
├── SPEC.md                    # Technical specification & architectural ground truth (this file)
├── AGENTS.md                  # Developer & AI agent operating protocols (4-phase workflow)
├── README.md                  # User-facing documentation, API overview, and release installation
├── LICENSE                    # MIT License
├── package.json               # Package metadata, exports, and test/demo scripts
├── src/
│   ├── index.js               # Public entry point (WasiHost, ProcExit, normalizePath, constants)
│   ├── constants.js           # WASI Preview 1 errnos, filetypes, flags, whence, and rights
│   ├── vfs-adapter.js         # Unified adapter for OverlayVFS, Map, and plain-object VFS stores
│   └── wasi-host.js           # Core WasiHost implementation (process, FD table, devices, FS)
├── types/
│   └── index.d.ts             # TypeScript declarations for all public APIs and options
├── examples/
│   ├── host-reference.js      # Zero-dependency Node.js reference runner & self-test
│   ├── demo.html              # Interactive browser worker demo (stdio, clock, VFS, devices)
│   └── serve.js               # Local static dev server with COOP/COEP headers
└── test/
    ├── wasi-host.test.js      # Core WasiHost lifecycle, process syscalls, and ProcExit tests
    ├── vfs-adapter.test.js    # OverlayVFS, Map, EROFS, mtime, and delta tracking tests
    ├── devices.test.js        # /dev/null, /dev/zero, and stdio descriptor behavior tests
    └── syscalls.test.js       # Full WASI Preview 1 ABI memory layout & edge-case tests
```

---

## 5. Public API & Constructor Specification

### 5.1 Package Exports (`package.json`)

- `"."` -> `./src/index.js`: Exports `WasiHost`, `ProcExit`, `normalizePath`, and WASI constants (`ESUCCESS`, `EBADF`, `EEXIST`, `EINVAL`, `EISDIR`, `ENOENT`, `ENOSYS`, `ENOTDIR`, `ENOTEMPTY`, `EPERM`, `EROFS`, etc.).
- `"./constants"` -> `./src/constants.js`: WASI Preview 1 constants only.
- `"./vfs-adapter"` -> `./src/vfs-adapter.js`: Lightweight VFS normalization adapter.

### 5.2 `WasiHost` Constructor Options

```javascript
import { WasiHost, ProcExit, normalizePath } from 'wasi-host';

const host = new WasiHost({
  vfs: overlayVfsOrMap,              // OverlayVFS, Map<string, Uint8Array|string>, or plain object
  fsImports: null,                   // Optional prebuilt FS imports (e.g. from vfs-wasi/wasi-fs)
  cwd: '/',                          // Current working directory (default: '/')
  argv: ['wasm'],                    // Command-line arguments (default: ['wasm'])
  environ: { HOME: '/', PWD: '/' },  // Environment variables (default: { HOME: cwd, PWD: cwd })
  stdin: null,                       // Stdin reader function, Uint8Array, or string
  stdout: (text) => {},              // Stdout text callback
  stderr: (text) => {},              // Stderr text callback (defaults to stdout)
  getMemory: () => instance.exports.memory, // WebAssembly.Memory getter or instance
  preopens: [                        // Preopened directory descriptors
    { fd: 3, path: cwd, name: '.' },
    { fd: 4, path: '/', name: '/' },
  ],
  systemDirs: ['/dev'],              // Top-level system paths preserved during root resolution
  nextFd: 10,                        // Starting fd for dynamically opened files/dirs (default: 10)
  onFileSync: (path, bytes) => {},   // Invoked when a mutable file is written/flushed/renamed
  onFileDelete: (path) => {},        // Invoked when a file or directory is removed/renamed away
  wasiWrapper: null,                 // Optional (wasiImports, host) => wrappedWasiImports (e.g. wrapWasiPipes)
  envProvider: null,                 // Optional (host) => Record<string, Function> (e.g. createBusyboxBridge)
  strictStubs: false,                // Return ENOSYS for unimplemented stubs instead of ESUCCESS (default: false)
});
```

### 5.3 `ProcExit` Error Class

```javascript
export class ProcExit extends Error {
  constructor(code, changedFiles = null, deletedFiles = null) {
    super(`Exited with code ${code}`);
    this.code = code;
    this.changedFiles = changedFiles;   // Map<string, Uint8Array> | null
    this.deletedFiles = deletedFiles;   // Set<string> | null
  }
}
```

### 5.4 `normalizePath(path)`

- Empty/falsy paths resolve to `'/'`.
- Preserves leading slash distinction (absolute vs. relative).
- Collapses redundant slashes (`//`), strips `.` segments, resolves `..` segments without escaping `/`, and strips trailing slashes (except `'/'`).

---

## 6. File Descriptor Table & Ecosystem Contracts

To allow clean composition with `busybox-wasi/host` (`wrapWasiPipes`, `createBusyboxBridge`) and `stdin-wasi` without subclassing or monkey-patching internal fields, `WasiHost` guarantees the following public instance properties and methods:

### 6.1 Standard & Preopened Descriptors
- `fd 0`: `stdin` (`isStdio: true, canRead: true, canWrite: false`)
- `fd 1`: `stdout` (`isStdio: true, canRead: false, canWrite: true`)
- `fd 2`: `stderr` (`isStdio: true, canRead: false, canWrite: true`)
- `preopens`: Default `[{ fd: 3, path: cwd, name: '.' }, { fd: 4, path: '/', name: '/' }]` (configurable; supports empty array for sandboxed modules without FS access).
- Dynamic descriptors: Allocated starting from `nextFd` (default `10`) to avoid colliding with preopens or shell-reserved low descriptors (`0..9`).

### 6.2 Public FD Table Contract (for `busybox-wasi` / Pipe Wrappers)
- `host.openFiles`: `Map<number, FdEntry>` mapping active file descriptors (`0`, `1`, `2`, and open files/dirs/devices) to descriptor metadata.
- `host.allocateFd(minFd = 0)`: Returns the lowest unused integer file descriptor `>= Math.max(minFd, this.nextFd)` (or `>= minFd` when explicitly requested for `dup`/`fcntl` style allocation, avoiding `openFiles` and `preopens` collisions).
- `host.setMemory(memoryOrGetter)`: Updates `getMemory` dynamically after `WebAssembly.instantiate` completes.
- `host.mem()`, `host.memU8()`, `host.memView()`: Safe WebAssembly linear memory and little-endian `DataView` accessors throwing a descriptive error if memory is unavailable or detached.

### 6.3 Mutation Tracking State
- `host.changedFiles`: `Map<string, Uint8Array>` recording created/modified/renamed-to files.
- `host.deletedFiles`: `Set<string>` recording unlinked files, removed directories, and renamed-from paths.
- `host.createdDirs`: `Set<string>` recording directories created during execution.

---

## 7. VFS Adapter & `vfs-wasi` Composition

`WasiHost` supports two backing modes seamlessly via `src/vfs-adapter.js`:

1. **`OverlayVFS` / `vfs-wasi` Mode**:
   - Detects `OverlayVFS` capability (`exists`, `readFile`, `writeFile`, `mkdir`, `removeFile`/`remove`, `removeDir`/`rmdir`, `rename`, `readDir`, `stat`, `_isReadOnly`, `setTimes`).
   - Enforces `_isReadOnly(path)` before any mutating operation (`path_open` with write/create/truncate/append intent, `path_create_directory`, `path_unlink_file`, `path_remove_directory`, `path_rename`, `path_filestat_set_times`), returning `EROFS` (`65`).
   - Preserves `mtime` from `vfs.stat(path)` in `path_filestat_get` and `fd_filestat_get`, and propagates `path_filestat_set_times` / `fd_filestat_set_times` updates to VFS.
2. **Standalone `Map` / Plain-Object Mode**:
   - Supports `Map<string, Uint8Array | string>` and plain JS objects `{ [path]: Uint8Array | string }` for zero-setup unit tests and lightweight embedding.
   - Tracks directories automatically from path prefixes and `createdDirs`.

### 7.1 Preopened Path Resolution Rules
- Relative paths resolve against the preopened directory for `dirfd`.
- Leading `./` and redundant slashes are normalized via `normalizePath`.
- When `dirfd` maps to `/` (e.g., `fd 4`) and a relative path does not match an existing top-level entry in VFS or `systemDirs` (e.g., bare relative filename `script.py` passed by a tool), `resolvePath` resolves it relative to `this.cwd` while preserving explicit system paths such as `dev/null` -> `/dev/null`.

---

## 8. WASI Preview 1 Syscall & Virtual Device Specification

`host.getImports()` returns the `wasi_snapshot_preview1` syscall table (wrapped by `wasiWrapper` if provided, with a fallback Proxy returning `ESUCCESS` or `ENOSYS` as configured—defaulting unimplemented non-critical stubs to `ESUCCESS` for libc compatibility, or configurable strict `ENOSYS` mode).

### 8.1 Process, Clock, Random & Polling Syscalls
| Syscall | Behavior |
|---|---|
| `args_sizes_get` / `args_get` | Serializes `this.argv` UTF-8 byte lengths and null-terminated pointers. |
| `environ_sizes_get` / `environ_get` | Serializes `this.environ` `KEY=VALUE\0` entries. |
| `clock_time_get` | Returns nanosecond timestamp (`BigInt`) for `CLOCKID_REALTIME (0)` and `CLOCKID_MONOTONIC (1)` (`performance.now()` / `Date.now()`). |
| `clock_res_get` | Reports clock resolution (`1000n` ns). |
| `random_get` | Fills destination buffer via `crypto.getRandomValues()` (chunked to 65,536 bytes per call per Web Crypto API spec). |
| `poll_oneoff` | Processes `__wasi_subscription_t` records (48-byte stride) and writes 32-byte `__wasi_event_t` outputs. Supports `CLOCK` relative and absolute (`ABSTIME`) timeouts via `Atomics.wait()` on a private 4-byte `SharedArrayBuffer` when supported in workers, with safe fallback when `Atomics.wait` is unavailable (e.g., main thread or non-isolated contexts). |
| `sched_yield` | Returns `ESUCCESS`. |
| `proc_exit` | Throws `new ProcExit(code, this.changedFiles, this.deletedFiles)`. |

### 8.2 Filesystem & Descriptor Syscalls
| Syscall | Behavior |
|---|---|
| `fd_prestat_get` / `fd_prestat_dir_name` | Advertises `PREOPENTYPE_DIR (0)` and writes preopen names. |
| `fd_fdstat_get` / `fd_fdstat_set_flags` | Reports filetype (`CHARACTER_DEVICE`, `DIRECTORY`, `REGULAR_FILE`), fdflags, and capability rights (`0x1fffffffffffffffn`). |
| `fd_filestat_get` / `fd_filestat_set_size` / `fd_filestat_set_times` | Reads/updates 64-byte `__wasi_filestat_t` (`dev = 1n`, unique `BigInt` inode per normalized path, filetype, `nlink = 1n`, `size`, `atim`, `mtim`, `ctim`). |
| `path_filestat_get` / `path_filestat_set_times` | Path-based stat and timestamp updates without opening a descriptor. |
| `path_open` | Enforces `EROFS`, `O_CREAT`, `O_TRUNC`, `O_EXCL`, `O_DIRECTORY`, `FDFLAG_APPEND`, and allocates descriptor `>= nextFd`. |
| `fd_read` / `fd_pread` | Scatter-gather reads into `iovec` arrays. `fd 0` delegates to `stdin` (function callback, `Uint8Array`, or string); `fd_pread` reads at explicit offset without advancing cursor. |
| `fd_write` / `fd_pwrite` | Scatter-gather writes from `ciovec` arrays. `fd 1`/`fd 2` decode UTF-8 safely and emit to `stdout`/`stderr`; regular files update VFS, `changedFiles`, and `onFileSync`. |
| `fd_seek` / `fd_tell` | `SEEK_SET (0)`, `SEEK_CUR (1)`, `SEEK_END (2)`; returns `ESUCCESS` (`0`) for virtual character devices. |
| `fd_close` / `fd_sync` / `fd_datasync` | Releases descriptor from `openFiles`; sync calls return `ESUCCESS`. |
| `fd_readdir` | Packs 24-byte `__wasi_dirent_t` headers + UTF-8 entry names with deterministic cookie pagination. |
| `path_create_directory` / `path_remove_directory` | Creates directories or removes empty directories (`ENOTEMPTY`/`EEXIST` if non-empty, `EROFS` if protected). |
| `path_unlink_file` | Unlinks regular files (`EISDIR` on dirs, `ENOENT` if missing, `EROFS` if protected) and triggers `onFileDelete`. |
| `path_rename` | Atomically moves/renames files or directories (`EROFS` on protected source or target) and updates `deletedFiles` / `changedFiles`. |

### 8.3 Virtual Character Devices (`/dev/null`, `/dev/zero`)
- `/dev/null` and `/dev/zero` are handled in memory without mutating VFS:
  - `stat`: Reports `FILETYPE_CHARACTER_DEVICE (2)`, `size = 0n`.
  - `/dev/null`: `fd_read` returns `0` bytes (EOF); `fd_write` reports full byte count written and discards bytes.
  - `/dev/zero`: `fd_read` fills target `iovec` slices with `0x00`; `fd_write` reports full byte count written and discards bytes.
  - `fd_seek`: Succeeds with offset `0n`.

### 8.4 Import Object Assembly (`createImportObject`)

```javascript
const imports = host.createImportObject(customEnv);
// Returns:
// {
//   wasi_snapshot_preview1: wasiImports,
//   wasi_unstable: wasiImports,
//   env: Proxy({ ...envProviderImports, ...customEnv }, fallbackToZero)
// }
```

---

## 9. Packaging & Distribution

- `wasi-host` is distributed as an ES Module `.tgz` archive attached to **GitHub Releases** (`https://github.com/breeze833/wasi-host/releases`), packaged via `npm run pack` (`dist/wasi-host-<version>.tgz`).
- Automated via `.github/workflows/release.yml` on `v*` tag pushes: publishes the versioned `v*` release and force-updates the rolling `latest` git tag and `latest` release (ensuring both the `.tgz` tarball and `latest` source archives stay synchronized).
- It is **not** published to the public npmjs registry.

---

## 10. Verification & Testing Standards

1. **Automated Suite (`npm test`)**:
   - `test/wasi-host.test.js`: `ProcExit`, `argv`, `environ`, `clock_*`, `random_get`, `poll_oneoff`, `createImportObject`, and `wasiWrapper`/`envProvider` composition.
   - `test/vfs-adapter.test.js`: `OverlayVFS` and `Map` backing, `EROFS`, `mtime`, `changedFiles`/`deletedFiles`, `onFileSync`/`onFileDelete`.
   - `test/devices.test.js`: `/dev/null`, `/dev/zero`, `stdin`/`stdout`/`stderr`, `fd_pread`/`fd_pwrite`.
   - `test/syscalls.test.js`: WASI binary struct alignments (`__wasi_filestat_t`, `__wasi_dirent_t`, `__wasi_subscription_t`, `__wasi_event_t`), `fd_readdir` pagination, `SharedArrayBuffer` `TextDecoder` safety, and real `.wasm` execution via `examples/host-reference.js`.
2. **Manual Verification (`npm run demo`)**:
   - Interactive Node.js reference runner (`examples/host-reference.js`) and browser worker demo (`examples/demo.html` served via `examples/serve.js`).
