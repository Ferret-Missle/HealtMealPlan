import httpx
from .adapter import LLMAdapter, LLMResponse

MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions"
DEFAULT_MODEL = "mistral-large-latest"


class MistralBYOKAdapter(LLMAdapter):
    supports_vision = False

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                MISTRAL_API_URL,
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
                    "max_tokens": 2048,
                },
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {}) or {}
        return LLMResponse(
            text=content,
            model=DEFAULT_MODEL,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )
