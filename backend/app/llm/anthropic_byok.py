import httpx
import base64
from .adapter import LLMAdapter, LLMResponse

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-sonnet-4-5"


class AnthropicBYOKAdapter(LLMAdapter):
    supports_vision = True

    def __init__(self, api_key: str, model: str | None = None):
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL

    def _headers(self) -> dict:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                ANTHROPIC_API_URL,
                headers=self._headers(),
                json={
                    "model": self.model,
                    "system": system,
                    "messages": [{"role": "user", "content": user}],
                    "max_tokens": 2048,
                },
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["content"][0]["text"]
        usage = data.get("usage", {}) or {}
        return LLMResponse(
            text=content,
            model=self.model,
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
        )

    async def complete_vision(self, system: str, user: str, image_b64: str, mime: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                ANTHROPIC_API_URL,
                headers=self._headers(),
                json={
                    "model": self.model,
                    "system": system,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image",
                                    "source": {
                                        "type": "base64",
                                        "media_type": mime,
                                        "data": image_b64,
                                    },
                                },
                                {"type": "text", "text": user},
                            ],
                        }
                    ],
                    "max_tokens": 1024,
                },
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["content"][0]["text"]
        usage = data.get("usage", {}) or {}
        return LLMResponse(
            text=content,
            model=self.model,
            input_tokens=usage.get("input_tokens"),
            output_tokens=usage.get("output_tokens"),
        )
