# dsh-local-worker

Bounded tools backed by a local OpenAI-compatible LLM (Ollama / llama.cpp):

- `local_llm_health`
- `local_task_plan`
- `local_task_transform`
- `local_task_validate`

The local model only returns proposals/verdicts; it never writes files or runs
commands. Every request is bounded by `timeoutMs` and `maxTokens`; invalid JSON,
oversized output and invented steps fail closed.

Default endpoint: `http://127.0.0.1:11435/v1`
Default model: `qwen2.5-coder:0.5b` (override in config; 3B/7B GGUF can be
pulled into the same service and selected with `model`).

See the workspace deployment guide and the `dsh-local-worker` skill for the fixed workflow.
