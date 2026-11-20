// A worker that loads but never reports ready: the render pool must treat it as unavailable.
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => undefined);
