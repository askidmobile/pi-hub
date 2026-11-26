import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { classify, type PiEvent } from "./events.js";
import { encodeJsonl, JsonlDecoder } from "./jsonl.js";

/**
 * Thin client for one `pi --mode rpc` child process (plan PD-001, ADR-0004).
 * - commands are correlated with responses by `id`;
 * - every decoded record is emitted raw (`record`) for the task log and classified (`event`);
 * - stop: close stdin -> SIGTERM -> SIGKILL (FR-012).
 */
export interface PiProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export class PiRpcError extends Error {
  constructor(
    public readonly command: string,
    message: string,
  ) {
    super(`pi ${command}: ${message}`);
    this.name = "PiRpcError";
  }
}

export class PiExitedError extends Error {
  constructor(
    public readonly code: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stderrTail: string,
  ) {
    super(
      `pi exited (code ${code ?? "null"}, signal ${signal ?? "none"})${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ""}`,
    );
    this.name = "PiExitedError";
  }
}

interface Pending {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiRpcClientEvents {
  record: [record: unknown];
  event: [event: PiEvent];
  parse_error: [line: string, error: string];
  exit: [error: PiExitedError];
}

const STDERR_TAIL_BYTES = 4096;

export class PiRpcClient extends EventEmitter<PiRpcClientEvents> {
  private child: ChildProcess | undefined;
  private readonly decoder = new JsonlDecoder();
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private stderrTail = "";
  private exitError: PiExitedError | undefined;
  private exited: Promise<PiExitedError> | undefined;

  constructor(private readonly spec: PiProcessSpec) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get hasExited(): boolean {
    return this.exitError !== undefined;
  }

  start(): void {
    if (this.child) throw new Error("PiRpcClient already started");
    const child = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    // Writing to a dead child must not crash the hub.
    child.stdin?.on("error", () => {});
    this.exited = new Promise((resolve) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitError) return;
        this.exitError = new PiExitedError(code, signal, this.stderrTail);
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(this.exitError);
        }
        this.pending.clear();
        this.emit("exit", this.exitError);
        resolve(this.exitError);
      };
      child.on("exit", finish);
      child.on("error", (err) => {
        this.stderrTail += `\nspawn error: ${err.message}`;
        finish(null, null);
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    for (const rec of this.decoder.push(chunk)) {
      if (!rec.ok) {
        this.emit("parse_error", rec.line, rec.error);
        continue;
      }
      this.emit("record", rec.value);
      const event = classify(rec.value);
      if (event.kind === "response" && event.record.id && this.pending.has(event.record.id)) {
        const p = this.pending.get(event.record.id) as Pending;
        this.pending.delete(event.record.id);
        clearTimeout(p.timer);
        if (event.record.success) p.resolve(event.record.data);
        else p.reject(new PiRpcError(p.command, event.record.error ?? "failed"));
      }
      this.emit("event", event);
    }
  }

  /** Raw write (e.g. `extension_ui_response`, which has no command response). */
  send(record: Record<string, unknown>): void {
    if (!this.child?.stdin || this.exitError) throw this.exitError ?? new Error("pi not started");
    this.child.stdin.write(encodeJsonl(record));
  }

  /** Send a command and wait for its response `data`. */
  request<T = unknown>(
    command: Record<string, unknown> & { type: string },
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.exitError) return Promise.reject(this.exitError);
    const id = `h${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(command.type, `no response in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        command: command.type,
        resolve: resolve as (d: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send({ ...command, id });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Accepts the prompt. Completion is `waitSettled()`, not this promise. */
  async prompt(message: string): Promise<{ disposition: string }> {
    return (await this.request({ type: "prompt", message })) as { disposition: string };
  }

  async followUp(message: string): Promise<void> {
    await this.request({ type: "follow_up", message });
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" }, 15_000);
  }

  async getLastAssistantText(): Promise<string | null> {
    const data = (await this.request({ type: "get_last_assistant_text" })) as {
      text: string | null;
    };
    return data?.text ?? null;
  }

  async getState(): Promise<{ sessionFile?: string; sessionId?: string; isStreaming?: boolean }> {
    return (await this.request({ type: "get_state" })) as {
      sessionFile?: string;
      sessionId?: string;
    };
  }

  async switchSession(sessionPath: string): Promise<void> {
    const data = (await this.request({ type: "switch_session", sessionPath })) as {
      cancelled?: boolean;
    };
    if (data?.cancelled) throw new PiRpcError("switch_session", "cancelled by an extension");
  }

  async getAvailableModels(): Promise<{ id: string; provider: string }[]> {
    const data = (await this.request({ type: "get_available_models" })) as {
      models: { id: string; provider: string }[];
    };
    return data?.models ?? [];
  }

  /**
   * Resolves on the next `agent_settled`; rejects if the process exits first.
   * Install before `prompt()` so a fast run is not missed.
   */
  waitSettled(): Promise<{ aborted: boolean }> {
    if (this.exitError) return Promise.reject(this.exitError);
    return new Promise((resolve, reject) => {
      const onEvent = (e: PiEvent) => {
        if (e.kind !== "agent_settled") return;
        cleanup();
        resolve({ aborted: e.aborted });
      };
      const onExit = (err: PiExitedError) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      this.on("event", onEvent);
      this.on("exit", onExit);
    });
  }

  /** Orderly shutdown: close stdin, then SIGTERM after half the grace, SIGKILL at the end. */
  async stop(graceMs = 10_000): Promise<PiExitedError> {
    if (!this.child || !this.exited) throw new Error("pi not started");
    if (this.exitError) return this.exitError;
    const child = this.child;
    child.stdin?.end();
    const step = (ms: number) =>
      Promise.race([
        this.exited as Promise<PiExitedError>,
        new Promise<null>((r) => setTimeout(() => r(null), ms)),
      ]);
    let res = await step(graceMs / 2);
    if (res) return res;
    child.kill("SIGTERM");
    res = await step(graceMs / 2);
    if (res) return res;
    child.kill("SIGKILL");
    return this.exited;
  }
}
