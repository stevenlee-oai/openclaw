export type ModelRequestObservation = {
  url: string;
  transport: "http" | "websocket";
  model?: string;
};

type ModelRequestObserver = (request: ModelRequestObservation) => void;
const observerKey: unique symbol = Symbol("openclaw.modelRequestObserver");

/** Private per-call observation; enumerable so ordinary option spreads retain it. */
export function withModelRequestObserver<T extends object>(
  options: T,
  observer: ModelRequestObserver,
): T {
  Object.defineProperty(options, observerKey, {
    enumerable: true,
    configurable: true,
    value: observer,
  });
  return options;
}

function readModelRequestObserver(options: object | undefined): ModelRequestObserver | undefined {
  const descriptor = options && Object.getOwnPropertyDescriptor(options, observerKey);
  const value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return isModelRequestObserver(value) ? value : undefined;
}

function isModelRequestObserver(value: unknown): value is ModelRequestObserver {
  return typeof value === "function";
}

export function copyModelRequestObserver<T extends object>(
  source: object | undefined,
  target: T,
): T {
  const observer = readModelRequestObserver(source);
  return observer ? withModelRequestObserver(target, observer) : target;
}

/** Observation must not change whether the provider request is attempted. */
export function notifyModelRequest(
  options: object | undefined,
  request: ModelRequestObservation | (() => ModelRequestObservation),
): void {
  try {
    const observer = readModelRequestObserver(options);
    if (observer) {
      observer(typeof request === "function" ? request() : request);
    }
  } catch {}
}
