import { mkdirSync, openSync, readFileSync, rmSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Повертає функцію звільнення або null, якщо інший запуск ще працює. */
export function acquireLock(path: string): (() => void) | null {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(readFileSync(path, 'utf-8').trim());
      if (pid && isAlive(pid)) return null;
      // Застарілий lock (процес помер, ноут заснув посеред запуску тощо)
      rmSync(path, { force: true });
    }
  }
  return null;
}
