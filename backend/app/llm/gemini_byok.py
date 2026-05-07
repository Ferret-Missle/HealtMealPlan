import httpx
from .adapter import LLMAdapter, LLMResponse

DEFAULT_MODEL = "gemini-1.5-flash"


class GeminiBYOKAdapter(LLMAdapter):
    supports_vision = True

    def __init__(self, api_key: str, model: str | None = None):
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL

    def _url(self, model: str, action: str = "generateContent") -> str:
        return f"https://generativelanguage.googleapis.com/v1beta/models/{model}:{action}?key={self.api_key}"

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                self._url(self.model),
                json={
                    "system_instruction": {"parts": [{"text": system}]},
                    "contents": [{"role": "user", "parts": [{"text": user}]}],
                    "generationConfig": {"maxOutputTokens": 2048},
                },
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["candidates"][0]["content"]["parts"][0]["text"]
        usage = data.get("usageMetadata", {}) or {}
        return LLMResponse(
            text=content,
            model=self.model,
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
        )

    async def complete_vision(self, system: str, user: str, image_b64: str, mime: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                self._url(self.model),
                json={
                    "system_instruction": {"parts": [{"text": system}]},
                    "contents": [
                        {
                            "role": "user",
                            "parts": [
                                {"inline_data": {"mime_type": mime, "data": image_b64}},
                                {"text": user},
                            ],
                        }
                    ],
                    "generationConfig": {"maxOutputTokens": 1024},
                },
            )
        resp.raise_for_status()
        data = resp.json()
        content = data["candidates"][0]["content"]["parts"][0]["text"]
        usage = data.get("usageMetadata", {}) or {}
        return LLMResponse(
            text=content,
            model=self.model,
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
        )
