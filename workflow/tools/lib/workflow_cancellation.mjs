let activeSignal;
export const throwIfWorkflowCanceled = () => activeSignal?.throwIfAborted();

export function installWorkflowCancellation(processApi = process) {
  const controller = new AbortController();
  activeSignal = controller.signal;
  const stop = (status = "interrupted") => controller.abort(Object.assign(new Error(`workflow_${status}`), { status, code: "WORKFLOW_CANCELED" }));
  const interrupt = () => stop();
  const message = (value) => { if (value?.type === "paperecho_cancel") stop(value.status === "timed_out" ? "timed_out" : "interrupted"); };
  processApi.on("SIGINT", interrupt); processApi.on("SIGTERM", interrupt); processApi.on("message", message);
  return { signal: controller.signal, dispose() {
    processApi.removeListener("SIGINT", interrupt); processApi.removeListener("SIGTERM", interrupt); processApi.removeListener("message", message);
    activeSignal = undefined;
  } };
}
