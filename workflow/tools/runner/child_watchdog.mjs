import { spawn } from "node:child_process";

export function forceChildTree(child, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0 || child.exitCode != null || child.signalCode != null) return;
  if (platform === "win32") {
    const killer = spawnImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", timeout: 5000 });
    killer.on("error", () => { try { child.kill("SIGKILL"); } catch {} });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}

export function watchProductionChild(child, {
  timeoutMs, graceMs = 10000, processApi = process, platform = process.platform,
  force = forceChildTree, onStop = () => {}, onUnreaped = () => {},
} = {}) {
  let finished = false, status = null, graceTimer, reapTimer;
  const stop = (nextStatus) => {
    if (finished || status) return;
    status = nextStatus;
    onStop(status);
    // IPC is the cooperative Windows path: child can flush phase/ledger/lease.
    if (child.connected && typeof child.send === "function") {
      try { child.send({ type: "paperecho_cancel", status }, () => {}); } catch {}
    } else if (platform !== "win32") {
      try { child.kill("SIGTERM"); } catch {}
    }
    graceTimer = setTimeout(() => {
      if (finished) return;
      force(child, { platform });
      reapTimer = setTimeout(() => { if (!finished) onUnreaped(status); }, 6000);
    }, graceMs);
  };
  const interrupted = () => stop("interrupted");
  const message = (value) => { if (value?.type === "paperecho_cancel") interrupted(); };
  const timer = setTimeout(() => stop("timed_out"), timeoutMs);
  processApi.on("SIGINT", interrupted);
  processApi.on("SIGTERM", interrupted);
  processApi.on("message", message);
  return {
    get status() { return status; },
    cleanup() {
      finished = true;
      clearTimeout(timer); clearTimeout(graceTimer); clearTimeout(reapTimer);
      processApi.removeListener("SIGINT", interrupted);
      processApi.removeListener("SIGTERM", interrupted);
      processApi.removeListener("message", message);
    },
  };
}
