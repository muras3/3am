export default async function globalTeardown(): Promise<void> {
  const pid = process.env["E2E_RECEIVER_PID"];
  if (pid) {
    try {
      process.kill(parseInt(pid, 10), "SIGTERM");
    } catch {
      // Process already exited — nothing to do
    }
  }
}
