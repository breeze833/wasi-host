# AGENTS.md: Developer & AI Agent Guidelines for `wasi-host`

This document defines the scope, architectural invariants, restrictions, and mandatory 4-phase development workflow for AI agents and contributors working on `wasi-host`.

---

## 1. Scope & Architectural Boundaries

`wasi-host` is a **pure JavaScript, language-neutral WASI Preview 1 (`wasi_snapshot_preview1` / `wasi_unstable`) process and execution host**.

### In Scope
- WASI Preview 1 process syscalls (`args_*`, `environ_*`, `clock_*`, `random_get`, `poll_oneoff`, `sched_yield`, `proc_exit`).
- WASI Preview 1 descriptor & filesystem syscalls (`path_open`, `fd_read`, `fd_pread`, `fd_write`, `fd_pwrite`, `fd_seek`, `fd_tell`, `fd_close`, `fd_readdir`, `fd_fdstat_*`, `fd_*filestat_*`, `path_filestat_*`, `path_create_directory`, `path_remove_directory`, `path_unlink_file`, `path_rename`, `fd_prestat_*`).
- Virtual character devices (`/dev/null`, `/dev/zero`) and standard stdio routing (`fd 0`, `fd 1`, `fd 2`).
- Unified VFS adapter supporting `vfs-wasi` (`OverlayVFS`), `Map`, and plain object stores, including `EROFS` enforcement, `mtime` preservation, and mutation tracking (`changedFiles`, `deletedFiles`, `onFileSync`, `onFileDelete`).
- Standardized FD-table and extension contracts (`openFiles`, `allocateFd`, `wasiWrapper`, `envProvider`, `createImportObject`).

### Out of Scope (Strictly Prohibited)
- **No Language/Toolchain Coupling**: Do **not** add C/C++ compiler logic (`clang`, `gcc`, `wasm-ld`), Python runtime logic, Makefile parsing, or hardcoded language paths (`/usr/include`, `/usr/lib`, `./a.out`, `PYTHONHOME`) inside `wasi-host`.
- **No Shell/UI/Graphics Coupling**: Do **not** embed BusyBox-specific `__host_*` syscalls, `xterm.js`, Monaco, DOM APIs, or `canvas-wasi` / `raylib-wasi` host imports directly inside `wasi-host`. Those belong in their respective packages and plug in via `wasiWrapper`, `envProvider`, or `customEnv`.
- **No Required Runtime Dependencies**: Keep `dependencies` empty in `package.json`. Integrations with `vfs-wasi`, `stdin-wasi`, or `busybox-wasi` must work via duck-typed interfaces / constructor hooks or optional `devDependencies` for testing.

---

## 2. Core Design Invariants

1. **Specification Ground Truth**: `SPEC.md` is the authoritative specification. Never introduce undocumented APIs, syscalls, or behavioral deviations.
2. **`SharedArrayBuffer` & W3C `TextDecoder` Safety**: Never pass a `SharedArrayBuffer`-backed view directly to `TextDecoder.decode()`. Always copy path or string slices into an unshared `Uint8Array` first when `u8.buffer instanceof SharedArrayBuffer`.
3. **Byte-Aligned `DataView` Access**: Read and write multi-byte WASI structs (`__wasi_filestat_t`, `__wasi_dirent_t`, `__wasi_subscription_t`, `__wasi_event_t`, `iovec`, `off_t`) using little-endian `DataView` methods rather than assuming host-aligned `Uint32Array`/`BigInt64Array` offsets where unaligned pointers can occur.
4. **`EROFS` & Read-Only Safety**: Respect `vfs._isReadOnly(path)` before every mutating filesystem syscall and return WASI `EROFS` (`65`).
5. **Non-Blocking / Isolated Fallback**: `poll_oneoff` may use `Atomics.wait()` inside Web Workers when `SharedArrayBuffer` is available, but must fall back gracefully on the main thread or when cross-origin isolation is disabled.
6. **Clean `openFiles` / `allocateFd` Contract**: Preserve `host.openFiles` (`Map`) and `host.allocateFd(minFd)` semantics so `busybox-wasi/host` (`wrapWasiPipes`, `createBusyboxBridge`) composes without subclass patching.

---

## 3. Mandatory 4-Phase Development Workflow

All agent-assisted changes in `wasi-host` **must** strictly follow this 4-phase lifecycle. Skipping phases, implementing before `SPEC.md` confirmation, or committing without explicit instruction is prohibited.

```
┌──────────────────────────────────────────────────────────────┐
│  Phase 1: Confirm SPEC.md Revision                           │
│  - Draft or update SPEC.md with design & API rationale       │
│  - Present changes and wait for explicit user confirmation   │
└──────────────────────────────┬───────────────────────────────┘
                               │ Confirmed
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 2: Develop & Auto-Testing                             │
│  - Implement code strictly matching the confirmed SPEC.md    │
│  - Write/update automated tests and verify `npm test` passes │
└──────────────────────────────┬───────────────────────────────┘
                               │ Auto-tests pass
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 3: Manual Verification / Testing                      │
│  - Pause and ask the developer to run manual verification    │
│  - Provide exact commands / test cases (`npm run demo`, etc.)│
└──────────────────────────────┬───────────────────────────────┘
                               │ Developer confirms
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Phase 4: Align Documents & Commit                           │
│  - Wait for explicit developer instruction to finalize       │
│  - Align README.md, types/index.d.ts, and package metadata   │
│  - Stage and commit changes to git                           │
└──────────────────────────────────────────────────────────────┘
```

### Phase Rules & Restrictions

1. **Phase 1 — Confirm `SPEC.md` Revision**:
   - Before writing or modifying any `src/`, `test/`, or `examples/` code for a new feature, refactor, or bug fix, update `SPEC.md` first (or present the proposed `SPEC.md` revision).
   - **Stop and wait** for the developer's explicit approval before starting Phase 2.
2. **Phase 2 — Develop & Auto-Testing**:
   - Implement only what was confirmed in `SPEC.md`.
   - Maintain high code quality: no duplicated logic, shallow nesting, small single-purpose helpers, and clear docstrings.
   - Add or update automated tests under `test/` covering normal paths, edge cases, and error codes.
   - Run `npm test` after the final edit and verify all tests pass with zero skipped or relaxed assertions.
3. **Phase 3 — Manual Verification / Testing**:
   - Do **not** declare the task finished immediately after `npm test` passes.
   - Present the automated test results and prompt the developer to perform manual verification (e.g., running `npm run demo`, testing `examples/host-reference.js`, or verifying integration against `wasm-c-ide` / `python-wasi`), listing concrete things to check.
   - **Stop and wait** for the developer to confirm manual testing results.
4. **Phase 4 — Align Documents & Commit**:
   - Do **not** unilaterally rewrite `README.md`, `types/index.d.ts`, or run `git commit` / `git tag` / `git push` without explicit developer instruction.
   - Once instructed, align `README.md`, `types/index.d.ts`, and `package.json` with the verified implementation, verify tests still pass if code/docs affect packaged files, and commit cleanly.

---

## 4. Development & Testing Commands

```bash
# Run automated test suite
npm test

# Run standalone Node.js reference runner
npm run test:host

# Start local interactive demo server
npm run demo

# Pack release tarball into dist/
npm run pack

# Verify release tarball contents
npm pack --dry-run
```
