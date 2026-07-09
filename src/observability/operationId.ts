let fallbackOperationCounter = 0;

export function createIpcOperationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `ipc-${globalThis.crypto.randomUUID()}`;
  }
  fallbackOperationCounter += 1;
  return `ipc-${Date.now().toString(36)}-${fallbackOperationCounter.toString(36)}`;
}
