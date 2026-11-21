// Zero-dependency Node.js reference runner & self-test for wasi-host
// Dynamically constructs valid wasm32-wasip1 modules and executes them via WasiHost.

import assert from 'node:assert/strict';
import { WasiHost, ProcExit } from '../src/index.js';

/**
 * Minimal WebAssembly binary encoder for a WASI module that:
 * - imports `wasi_snapshot_preview1.fd_write` (func 0)
 * - imports `wasi_snapshot_preview1.proc_exit` (func 1)
 * - exports `memory` (1 page) and `_start`
 * - writes a greeting message to fd 1 and exits with code 42.
 */
function buildHelloExitWasm(message = 'Hello from WasiHost!\n', exitCode = 42) {
  const msgBytes = Array.from(new TextEncoder().encode(message));
  const msgPtr = 1024;
  const iovPtr = 2048;
  const nwrittenPtr = 2064;

  const encodeU32Leb = (n) => {
    const out = [];
    let val = n >>> 0;
    do {
      let b = val & 0x7f;
      val >>>= 7;
      if (val !== 0) b |= 0x80;
      out.push(b);
    } while (val !== 0);
    return out;
  };

  const encodeI32Leb = (n) => {
    const out = [];
    let val = n | 0;
    let more = true;
    while (more) {
      let b = val & 0x7f;
      val >>= 7;
      if ((val === 0 && (b & 0x40) === 0) || (val === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      out.push(b);
    }
    return out;
  };

  const section = (id, payload) => [id, ...encodeU32Leb(payload.length), ...payload];
  const strBytes = (s) => {
    const b = Array.from(new TextEncoder().encode(s));
    return [...encodeU32Leb(b.length), ...b];
  };

  // Type section:
  // type 0: (i32, i32, i32, i32) -> i32  (fd_write)
  // type 1: (i32) -> ()                 (proc_exit)
  // type 2: () -> ()                    (_start)
  const typeSection = section(1, [
    3,
    0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f,
    0x60, 1, 0x7f, 0,
    0x60, 0, 0,
  ]);

  // Import section:
  // func 0: wasi_snapshot_preview1.fd_write (type 0)
  // func 1: wasi_snapshot_preview1.proc_exit (type 1)
  const importSection = section(2, [
    2,
    ...strBytes('wasi_snapshot_preview1'), ...strBytes('fd_write'), 0x00, 0,
    ...strBytes('wasi_snapshot_preview1'), ...strBytes('proc_exit'), 0x00, 1,
  ]);

  // Function section: func 2 (_start) -> type 2
  const funcSection = section(3, [1, 2]);

  // Memory section: 1 page min
  const memSection = section(5, [1, 0x00, 1]);

  // Export section: memory (mem 0), _start (func 2)
  const exportSection = section(7, [
    2,
    ...strBytes('memory'), 0x02, 0,
    ...strBytes('_start'), 0x00, 2,
  ]);

  // Code section for _start:
  // i32.const iovPtr; i32.const msgPtr; i32.store 0
  // i32.const iovPtr+4; i32.const msgLen; i32.store 0
  // call fd_write(1, iovPtr, 1, nwrittenPtr); drop
  // call proc_exit(exitCode)
  const body = [
    0, // local count
    0x41, ...encodeI32Leb(iovPtr),
    0x41, ...encodeI32Leb(msgPtr),
    0x36, 2, 0,
    0x41, ...encodeI32Leb(iovPtr + 4),
    0x41, ...encodeI32Leb(msgBytes.length),
    0x36, 2, 0,
    0x41, 1,
    0x41, ...encodeI32Leb(iovPtr),
    0x41, 1,
    0x41, ...encodeI32Leb(nwrittenPtr),
    0x10, 0, // call fd_write
    0x1a,    // drop
    0x41, ...encodeI32Leb(exitCode),
    0x10, 1, // call proc_exit
    0x0b,    // end
  ];
  const codeSection = section(10, [1, ...encodeU32Leb(body.length), ...body]);

  // Data section: active segment at memory 0, offset msgPtr
  const dataSeg = [
    0x00,
    0x41, ...encodeI32Leb(msgPtr), 0x0b,
    ...encodeU32Leb(msgBytes.length), ...msgBytes,
  ];
  const dataSection = section(11, [1, ...dataSeg]);

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
    ...funcSection,
    ...memSection,
    ...exportSection,
    ...codeSection,
    ...dataSection,
  ]);
}

async function runReference() {
  const wasmBytes = buildHelloExitWasm('Hello from real Wasm binary!\n', 42);
  let output = '';

  const host = new WasiHost({
    cwd: '/workspace',
    argv: ['reference-app', '--check'],
    environ: { MODE: 'reference' },
    stdout: (text) => {
      output += text;
    },
  });

  const { instance } = await WebAssembly.instantiate(wasmBytes, host.createImportObject());
  host.setMemory(() => instance.exports.memory);

  let exitCode = 0;
  try {
    instance.exports._start();
  } catch (err) {
    if (err instanceof ProcExit) {
      exitCode = err.code;
    } else {
      throw err;
    }
  }

  assert.equal(output, 'Hello from real Wasm binary!\n');
  assert.equal(exitCode, 42);
  console.log('host-reference.js: PASSED (real Wasm fd_write + proc_exit verified)');
}

runReference().catch((err) => {
  console.error(err);
  process.exit(1);
});
