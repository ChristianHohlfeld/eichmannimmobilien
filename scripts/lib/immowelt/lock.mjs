/**
 * One lock for everything that writes the public site: Immowelt sync, release builds after a
 * deploy, admin publishes, rollbacks. A file created with O_EXCL; stale holders (dead PID or
 * older than the limit) are taken over and that takeover is reported.
 *
 * Child processes inherit the lock via EICHMANN_LOCK_TOKEN and never acquire it again.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export class LockBusyError extends Error {
  constructor(holder) {
    super(`Pipeline ist belegt (${holder?.purpose || "unbekannt"}, PID ${holder?.pid ?? "?"}, seit ${holder?.started_at || "?"}).`);
    this.name = "LockBusyError";
    this.code = "pipeline_busy";
    this.holder = holder || null;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{ token: string, inherited: boolean, tookOverFrom: object|null, release: () => void }>}
 */
export async function acquireLock(lockDir, { purpose = "pipeline", waitMs = 0, staleMinutes = 45, env = process.env, name = "pipeline.lock" } = {}) {
  fs.mkdirSync(lockDir, { recursive: true });
  const file = path.join(lockDir, name);
  const inheritedToken = env.EICHMANN_LOCK_TOKEN || null;
  if (inheritedToken) {
    const holder = readHolder(file);
    if (holder && holder.token === inheritedToken) return { token: inheritedToken, inherited: true, tookOverFrom: null, release: () => {} };
  }
  const deadline = Date.now() + waitMs;
  let tookOverFrom = null;
  for (;;) {
    const token = randomBytes(12).toString("hex");
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ token, pid: process.pid, purpose, started_at: new Date().toISOString() }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        const holder = readHolder(file);
        if (holder && holder.token === token) fs.rmSync(file, { force: true });
      };
      return { token, inherited: false, tookOverFrom, release };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const holder = readHolder(file);
    if (!holder) {
      // Unreadable: garbage from a crash – or a lock another process is writing this very moment.
      let young = false;
      try {
        young = Date.now() - fs.statSync(file).mtimeMs < 5_000;
      } catch {
        continue; // gone in the meantime – try to create it
      }
      if (young) {
        if (Date.now() >= deadline) throw new LockBusyError({ purpose: "wird gerade angelegt", pid: null, started_at: null });
        await sleep(100);
        continue;
      }
    }
    const ageMin = holder?.started_at ? (Date.now() - Date.parse(holder.started_at)) / 60000 : Infinity;
    if (!holder || !pidAlive(holder.pid) || ageMin > staleMinutes) {
      // Take over atomically: only the process that renames the stale file away may proceed.
      const grave = `${file}.stale-${process.pid}-${Date.now()}`;
      try {
        fs.renameSync(file, grave);
        // Between reading the stale holder and the rename another process may already have taken
        // over and written ITS lock. Then the file just moved away is a live lock: put it back
        // (link fails if a newer one exists) and look again instead of proceeding.
        const moved = readHolder(grave);
        if (moved && moved.token !== holder?.token) {
          try {
            fs.linkSync(grave, file);
          } catch {
            /* a newer lock is in place */
          }
          fs.rmSync(grave, { force: true });
          continue;
        }
        fs.rmSync(grave, { force: true });
        tookOverFrom = holder || { pid: null, purpose: "unlesbar" };
      } catch {
        /* someone else was faster – loop and look again */
      }
      continue;
    }
    if (Date.now() >= deadline) throw new LockBusyError(holder);
    await sleep(Math.min(1000, Math.max(50, deadline - Date.now())));
  }
}

export async function withLock(lockDir, opts, fn) {
  const lock = await acquireLock(lockDir, opts);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
