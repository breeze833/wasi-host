// WASI Preview 1 (wasi_snapshot_preview1) Standard Constants

// Error codes (errno)
export const ESUCCESS = 0;
export const EBADF = 8;
export const EEXIST = 20;
export const EINVAL = 28;
export const EISDIR = 31;
export const ENOENT = 44;
export const ENOSYS = 52;
export const ENOTDIR = 54;
export const EPERM = 63;
export const EROFS = 65;
export const ENOTEMPTY = 66;

// File types (__wasi_filetype_t)
export const FILETYPE_UNKNOWN = 0;
export const FILETYPE_BLOCK_DEVICE = 1;
export const FILETYPE_CHARACTER_DEVICE = 2;
export const FILETYPE_DIRECTORY = 3;
export const FILETYPE_REGULAR_FILE = 4;
export const FILETYPE_SOCKET_DGRAM = 5;
export const FILETYPE_SOCKET_STREAM = 6;
export const FILETYPE_SYMBOLIC_LINK = 7;

// Preopen types (__wasi_preopentype_t)
export const PREOPENTYPE_DIR = 0;

// Open flags (__wasi_oflags_t)
export const O_CREAT = 1;
export const O_DIRECTORY = 2;
export const O_EXCL = 4;
export const O_TRUNC = 8;

// File descriptor flags (__wasi_fdflags_t)
export const FDFLAG_APPEND = 1;
export const FDFLAG_DSYNC = 2;
export const FDFLAG_NONBLOCK = 4;
export const FDFLAG_RSYNC = 8;
export const FDFLAG_SYNC = 16;

// Seek whence (__wasi_whence_t)
export const WHENCE_SET = 0;
export const WHENCE_CUR = 1;
export const WHENCE_END = 2;

// Clock IDs (__wasi_clockid_t)
export const CLOCKID_REALTIME = 0;
export const CLOCKID_MONOTONIC = 1;
export const CLOCKID_PROCESS_CPUTIME_ID = 2;
export const CLOCKID_THREAD_CPUTIME_ID = 3;

// Event types & clock flags
export const EVENTTYPE_CLOCK = 0;
export const EVENTTYPE_FD_READ = 1;
export const EVENTTYPE_FD_WRITE = 2;
export const SUBCLOCKFLAGS_ABSTIME = 1;

// Filestat time flags (__wasi_fstflags_t)
export const FSTFLAGS_ATIM = 1;
export const FSTFLAGS_ATIM_NOW = 2;
export const FSTFLAGS_MTIM = 4;
export const FSTFLAGS_MTIM_NOW = 8;

// Capability rights (__wasi_rights_t)
export const RIGHTS_ALL = 0x1fffffffffffffffn;
export const RIGHT_FD_READ = 1n << 1n;
export const RIGHT_FD_SEEK = 1n << 2n;
export const RIGHT_FD_TELL = 1n << 5n;
export const RIGHT_FD_WRITE = 1n << 6n;
export const RIGHTS_TTY = RIGHTS_ALL & ~(RIGHT_FD_SEEK | RIGHT_FD_TELL);
