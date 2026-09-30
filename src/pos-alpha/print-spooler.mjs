import { randomUUID } from "node:crypto";

const TRANSITIONS = Object.freeze({
  QUEUED: ["PRINTING", "FAILED", "UNKNOWN"],
  PRINTING: ["PRINTED", "FAILED", "UNKNOWN"],
  FAILED: ["QUEUED"],
  UNKNOWN: ["PRINTED", "FAILED", "QUEUED"],
  PRINTED: [],
});

export class LocalPrintSpooler {
  constructor({ clock = () => new Date(), hardwareAvailable = false } = {}) {
    this.clock = clock;
    this.hardwareAvailable = hardwareAvailable;
    this.jobs = new Map();
  }

  create({ orderId, orderNumber, destination = "BAR", payload }) {
    const existing = [...this.jobs.values()].find((job) => job.orderId === orderId && job.copyNumber === 0);
    if (existing) return structuredClone(existing);
    const job = {
      id: randomUUID(), orderId, orderNumber, destination, payloadVersion: 1,
      payload: structuredClone(payload), copyNumber: 0, label: "ORIGINAL",
      status: this.hardwareAvailable ? "QUEUED" : "NOT_RUN_HARDWARE_UNAVAILABLE",
      attempts: 0, createdAt: this.clock().toISOString(), updatedAt: this.clock().toISOString(), audit: [],
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  transition(jobId, target, { actorId = "system", reason = "adapter_result" } = {}) {
    const job = this.#job(jobId);
    if (job.status === "NOT_RUN_HARDWARE_UNAVAILABLE") throw domainError("printer_hardware_unavailable", 409);
    if (!TRANSITIONS[job.status]?.includes(target)) throw domainError("print_transition_invalid", 409);
    job.status = target;
    job.updatedAt = this.clock().toISOString();
    if (["PRINTING", "QUEUED"].includes(target)) job.attempts += 1;
    job.audit.push({ actorId, action: `print.${target.toLowerCase()}`, reason, occurredAt: job.updatedAt });
    return structuredClone(job);
  }

  reprint(jobId, { actorId, reason } = {}) {
    const source = this.#job(jobId);
    if (!String(actorId ?? "").trim() || !String(reason ?? "").trim()) throw domainError("reprint_actor_reason_required", 422);
    const copyNumber = [...this.jobs.values()].filter((job) => job.orderId === source.orderId).length;
    const copy = {
      ...structuredClone(source), id: randomUUID(), copyNumber, label: `REPRINT COPY ${copyNumber}`,
      status: this.hardwareAvailable ? "QUEUED" : "NOT_RUN_HARDWARE_UNAVAILABLE",
      attempts: 0, createdAt: this.clock().toISOString(), updatedAt: this.clock().toISOString(),
      audit: [{ actorId, action: "print.reprint_requested", reason, occurredAt: this.clock().toISOString() }],
    };
    this.jobs.set(copy.id, copy);
    return structuredClone(copy);
  }

  list() { return [...this.jobs.values()].map((job) => structuredClone(job)); }

  #job(id) {
    const job = this.jobs.get(id);
    if (!job) throw domainError("print_job_not_found", 404);
    return job;
  }
}

function domainError(code, statusCode) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
