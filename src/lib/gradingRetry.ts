import type { Job, SessionItem } from "./types";

export function isTechnicalWrittenFailure(item: SessionItem): boolean {
  return (item.result === "fail" || item.result === "partial") &&
    (item.error_type === "grader_timeout" || item.error_type === "grader_json_error");
}

/** A failed pipeline is not a failed learner response. Never regrade success. */
export function canRetryGrading(job?: Job | null): boolean {
  return job?.status === "failed" && job.failure?.retryable === true &&
    job.failure.retry_action === "retry_grading_same_answer";
}
