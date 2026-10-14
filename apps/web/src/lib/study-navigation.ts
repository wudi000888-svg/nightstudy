// Writing an unchanged session creates a new router location without changing the
// task. Keep the current navigation and mounted page state when the link is exact.
export function linkStudySession(
  current: URLSearchParams,
  sessionId: string | null,
  write: (next: Record<string, string>) => void,
) {
  if (current.get('session') === sessionId) return;
  write(sessionId ? { session: sessionId } : {});
}
