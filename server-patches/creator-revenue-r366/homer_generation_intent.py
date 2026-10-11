"""Provider-independent continuation intent, not an output text filter."""
CONTINUATION_INSTRUCTION = "从上一条角色回复结束的位置接着写新的后续内容。不要重复、概括或重新回答之前的内容；保持人物设定与叙事连续。"
GENERATION_TYPES = frozenset({"normal", "continue", "regenerate", "quiet", "impersonate", "swipe"})


def continuation_instruction(body):
    action = body.get("homer_generation_type")
    if action is None:
        return ""  # Backward-compatible old clients; do not infer from user text.
    if not isinstance(action, str) or action not in GENERATION_TYPES:
        raise ValueError("invalid generation intent")
    return CONTINUATION_INSTRUCTION if action == "continue" else ""


def apply_continuation_intent(messages, body):
    instruction = continuation_instruction(body)
    if not instruction:
        return messages
    copied = [dict(item) for item in messages]
    if not copied or copied[-1].get("role") != "user" or copied[-1].get("content") != instruction:
        copied.append({"role": "user", "content": instruction})
    return copied
