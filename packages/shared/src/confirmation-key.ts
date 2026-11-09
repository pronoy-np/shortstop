/**
 * The R2 path (without extension) of a lot's confirmation documents for one commit. Commit keys are client-chosen, so
 * characters outside `[a-zA-Z0-9:_-]` are escaped as `.` plus four hex digits. The escape is injective (a literal `.` is
 * itself escaped), so two different keys can never share a path and overwrite each other's confirmation. Ordinary keys
 * (UUIDs, `lotId:uuid`) pass through unchanged. Shared by the Worker that writes the files and the board that links them.
 */
export const confirmationBase = (lotId: string, commitKey: string) =>
  `confirmations/${lotId}/${commitKey.replace(/[^a-zA-Z0-9:_-]/g, (c) => `.${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
