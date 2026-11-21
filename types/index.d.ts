export const ESUCCESS: number;
export const EBADF: number;
export const EEXIST: number;
export const EINVAL: number;
export const EISDIR: number;
export const ENOENT: number;
export const ENOSYS: number;
export const ENOTDIR: number;
export const EPERM: number;
export const EROFS: number;
export const ENOTEMPTY: number;

export const FILETYPE_UNKNOWN: number;
export const FILETYPE_BLOCK_DEVICE: number;
export const FILETYPE_CHARACTER_DEVICE: number;
export const FILETYPE_DIRECTORY: number;
export const FILETYPE_REGULAR_FILE: number;
export const FILETYPE_SOCKET_DGRAM: number;
export const FILETYPE_SOCKET_STREAM: number;
export const FILETYPE_SYMBOLIC_LINK: number;

export const PREOPENTYPE_DIR: number;

export const O_CREAT: number;
export const O_DIRECTORY: number;
export const O_EXCL: number;
export const O_TRUNC: number;

export const FDFLAG_APPEND: number;
export const FDFLAG_DSYNC: number;
export const FDFLAG_NONBLOCK: number;
export const FDFLAG_RSYNC: number;
export const FDFLAG_SYNC: number;

export const WHENCE_SET: number;
export const WHENCE_CUR: number;
export const WHENCE_END: number;

export const CLOCKID_REALTIME: number;
export const CLOCKID_MONOTONIC: number;
export const CLOCKID_PROCESS_CPUTIME_ID: number;
export const CLOCKID_THREAD_CPUTIME_ID: number;

export const EVENTTYPE_CLOCK: number;
export const EVENTTYPE_FD_READ: number;
export const EVENTTYPE_FD_WRITE: number;
export const SUBCLOCKFLAGS_ABSTIME: number;

export const FSTFLAGS_ATIM: number;
export const FSTFLAGS_ATIM_NOW: number;
export const FSTFLAGS_MTIM: number;
export const FSTFLAGS_MTIM_NOW: number;

export const RIGHTS_ALL: bigint;
export const RIGHT_FD_READ: bigint;
export const RIGHT_FD_SEEK: bigint;
export const RIGHT_FD_TELL: bigint;
export const RIGHT_FD_WRITE: bigint;
export const RIGHTS_TTY: bigint;

export interface PreopenEntry {
  fd: number;
  path: string;
  name?: string;
}

export interface FdEntry {
  fd: number;
  path?: string;
  isStdio?: boolean;
  isCharDev?: boolean;
  isDevNull?: boolean;
  isDevZero?: boolean;
  isDir?: boolean;
  canRead?: boolean;
  canWrite?: boolean;
  isAppend?: boolean;
  cursor?: number;
  [key: string]: unknown;
}

export interface WasiHostOptions {
  vfs?: object | Map<string, unknown> | null;
  fsImports?: Record<string, (...args: any[]) => any> | null;
  cwd?: string;
  argv?: string[];
  environ?: Record<string, string>;
  stdin?: ((iovsPtr: number, iovsLen: number, nreadOut: number, host: WasiHost) => number) | Uint8Array | string | null;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  getMemory?: WebAssembly.Memory | (() => WebAssembly.Memory | null) | null;
  preopens?: PreopenEntry[];
  systemDirs?: string[];
  nextFd?: number;
  onFileSync?: ((path: string, bytes: Uint8Array) => void) | null;
  onFileDelete?: ((path: string) => void) | null;
  wasiWrapper?: ((wasiImports: Record<string, Function>, host: WasiHost) => Record<string, Function>) | null;
  envProvider?: ((host: WasiHost) => Record<string, Function>) | null;
  strictStubs?: boolean;
}

export function normalizePath(path: string): string;
export function toUint8Array(value: unknown): Uint8Array;

export class VfsAdapter {
  constructor(vfs?: object | Map<string, unknown> | null, createdDirs?: Set<string>);
  isReadOnly(path: string): boolean;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  stat(path: string): { isDir: boolean; size: number; mtime: number } | null;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array | ArrayBuffer | string): Uint8Array;
  mkdir(path: string, recursive?: boolean): void;
  removeFile(path: string): void;
  removeDir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  setTimes(path: string, atimNs: bigint, mtimNs: bigint): void;
  readDir(path: string): Array<{ name: string; isDir: boolean }>;
  static mapErrorToErrno(err: unknown, fallback?: number): number;
}

export class ProcExit extends Error {
  code: number;
  changedFiles: Map<string, Uint8Array> | null;
  deletedFiles: Set<string> | null;
  constructor(code: number, changedFiles?: Map<string, Uint8Array> | null, deletedFiles?: Set<string> | null);
}

export class WasiHost {
  cwd: string;
  argv: string[];
  environ: Record<string, string>;
  preopens: PreopenEntry[];
  openFiles: Map<number, FdEntry>;
  changedFiles: Map<string, Uint8Array>;
  deletedFiles: Set<string>;
  createdDirs: Set<string>;
  nextFd: number;

  constructor(options?: WasiHostOptions);
  setMemory(memoryOrGetter: WebAssembly.Memory | (() => WebAssembly.Memory | null)): void;
  mem(): WebAssembly.Memory;
  memU8(): Uint8Array;
  memView(): DataView;
  allocateFd(minFd?: number): number;
  readStr(offset: number, len?: number): string;
  resolvePath(dirfd: number, pathStr: string): string;
  getImports(): Record<string, (...args: any[]) => any>;
  createImportObject(customEnv?: Record<string, (...args: any[]) => any>): {
    wasi_snapshot_preview1: Record<string, (...args: any[]) => any>;
    wasi_unstable: Record<string, (...args: any[]) => any>;
    env: Record<string, (...args: any[]) => any>;
  };
  getImportObject(customEnv?: Record<string, (...args: any[]) => any>): {
    wasi_snapshot_preview1: Record<string, (...args: any[]) => any>;
    wasi_unstable: Record<string, (...args: any[]) => any>;
    env: Record<string, (...args: any[]) => any>;
  };
}
