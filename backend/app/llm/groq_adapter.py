import httpx
from .adapter import LLMAdapter, LLMResponse

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"


class GroqAdapter(LLMAdapter):
    supports_vision = False

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                GROQ_API_URL,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": DEFAULT_MODEL,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0.7,
                    "max_completion_tokens": 2048,
                },
            )
        if resp.is_error:
            detail = None
            try:
                error_payload = resp.json()
                detail = (
                    error_payload.get("error", {}).get("message")
                    or error_payload.get("message")
                )
            except ValueError:
                detail = resp.text
            raise RuntimeError(
                f"Groq API error ({resp.status_code}): {detail or 'Unknown error'}"
            )
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {}) or {}
        return LLMResponse(
            text=content,
            model=DEFAULT_MODEL,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )
