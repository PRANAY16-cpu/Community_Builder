---
name: Groq model access and JSON output
description: Groq model access and structured-output constraints for the community assistant.
---

Use a model available to the user's Groq plan; a valid developer key can still receive HTTP 404 for enterprise-only models. The current developer-plan model is `openai/gpt-oss-20b`. Use strict JSON Schema output and a sufficient completion-token budget for reasoning-heavy calls.

**Why:** The key was present, but the original Enterprise-only model returned 404. Switching models alone still produced JSON validation errors; strict schemas plus a larger output budget made grounded Ask generation succeed. The earlier fallback concealed the provider error.

**How to apply:** When enabling or changing the Groq integration, check the current official model/structured-output docs, then verify a real Ask request returns `aiAvailable: true` with citations. Keep logs redacted: never log API keys, prompts, or generated content.
