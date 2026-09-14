/** Only incomplete capture requires a new take; network errors keep the Blob. */
export function isIncompleteRecordingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== "object") return false;
  const detail = (body as { detail?: unknown }).detail;
  return !!detail && typeof detail === "object"
    && (detail as { code?: unknown }).code === "recording_incomplete";
}
