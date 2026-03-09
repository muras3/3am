import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";

export default async function globalTeardown(): Promise<void> {
  const pidFile =
    process.env["E2E_RECEIVER_PID_FILE"] ??
    path.join(tmpdir(), "3amoncall-e2e-receiver.pid");
  try {
    const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited or PID file missing — nothing to do
  }
  try {
    unlinkSync(pidFile);
  } catch {
    // File already removed — nothing to do
  }
}
