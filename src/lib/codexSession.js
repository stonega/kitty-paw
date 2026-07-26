export const CODEX_THREAD_VARIABLE = 'kitty_session_restorer_codex_thread_id';

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexThreadId(value) {
  return typeof value === 'string' && CODEX_THREAD_ID_PATTERN.test(value);
}

export function codexSessionEventFromHookInput(input) {
  try {
    const payload = JSON.parse(input);
    if (!['SessionEnd', 'SessionStart'].includes(payload?.hook_event_name)) return null;
    if (!isCodexThreadId(payload.session_id)) return null;
    return {
      name: payload.hook_event_name,
      threadId: payload.session_id,
    };
  } catch {
    return null;
  }
}

export function codexThreadIdFromHookInput(input) {
  const event = codexSessionEventFromHookInput(input);
  return event?.name === 'SessionStart' ? event.threadId : null;
}
