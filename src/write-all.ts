import { writeSync } from 'fs';

/** Byte-level writer and back-off used by `writeAll`; injectable for tests. */
export type WriteAllIo = {
  /** Writes `buffer` from `offset` to the end; returns the bytes written, which may be fewer. Throws on errno. */
  write: (buffer: Uint8Array, offset: number) => number;
  /** Pauses before retrying after `EAGAIN` or a zero-byte write. */
  wait: () => void;
};

/** The `code` of an errno-style error (e.g. `'EPIPE'`), or undefined. */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Writes all of `text` as UTF-8 through `io`, retrying short writes and transient errors. Throws on any other write error. */
export function writeAll(io: WriteAllIo, text: string): void {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) {
    let written: number;
    try {
      written = io.write(buffer, offset);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
        io.wait();
        continue;
      }
      if (code === 'EINTR') continue;
      throw err;
    }
    if (written <= 0) {
      io.wait();
      continue;
    }
    offset += written;
  }
}

/** `writeAll` to a file descriptor, sleeping 1 ms between retries. Works on blocking and non-blocking fds. */
export function writeAllToFd(fd: number, text: string): void {
  writeAll({
    write: (buffer, offset) => writeSync(fd, buffer, offset),
    wait: () => Bun.sleepSync(1),
  }, text);
}
