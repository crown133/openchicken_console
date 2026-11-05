"""Explicit opt-in notifications; critical and administrative requests retain replies."""
ORDINARY_ACTIONS = frozenset(('sit_toggle', 'ground_pick', 'kick_left', 'kick_right',
                              'roulade', 'chirp', 'rest', 'shutdown'))


def notification(message):
    if not isinstance(message, dict) or message.get('reply') is not False:
        return False
    kind = message.get('type')
    if kind in ('pad_input', 'drive', 'head', 'action', 'heartbeat'):
        return True
    if kind == 'pad_command':
        payload = message.get('payload')
        actions = payload.get('actions') if isinstance(payload, dict) else None
        return isinstance(actions, list) and bool(actions) and all(
            isinstance(action, str) and action in ORDINARY_ACTIONS for action in actions)
    return False
