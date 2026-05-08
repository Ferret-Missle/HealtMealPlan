import httpx
from .adapter import LLMAdapter, LLMResponse

OPENAI_API_URL = "https://api.openai.com/v1/chat/completions"
DEFAULT_MODEL = "gpt-4o-mini"


class OpenAIBYOKAdapter(LLMAdapter):
    supports_vision = True

    def __init__(self, api_key: str, model: str | None = None):
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def complete(self, system: str, user: str, json_mode: bool = False) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                OPENAI_API_URL,
                headers=self._headers(),
                json={
                    "model": self.model,
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
            model=self.model,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )

    async def complete_vision(self, system: str, user: str, image_b64: str, mime: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                OPENAI_API_URL,
                headers=self._headers(),
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": f"data:{mime};base64,{image_b64}"
                                    },
                                },
                                {"type": "text", "text": user},
                            ],
                        },
                    ],
                    "max_tokens": 1024,
                },
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {}) or {}
        return LLMResponse(
            text=content,
            model=self.model,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )
