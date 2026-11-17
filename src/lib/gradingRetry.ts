import type { Job } from "./types";

/** A failed pipeline is not a failed learner response. Never regrade success. */
export function canRetryGrading(job?: Job | null): boolean {
  return job?.status === "failed" && job.failure?.retryable === true &&
    job.failure.retry_action === "retry_grading_same_answer";
}
