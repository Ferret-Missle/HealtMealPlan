import httpx
from .adapter import LLMAdapter, LLMResponse

GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = "llama-3.3-70b-versatile"


class GroqAdapter(LLMAdapter):
    supports_vision = False

    def __init__(self, api_key: str, model: str | None = None):
        self.api_key = api_key
        self.model = model or DEFAULT_MODEL

    async def complete(self, system: str, user: str) -> LLMResponse:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                GROQ_API_URL,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    # Groq の Llama 系は 0.7 だと繰り返しが起きやすい。
                    # 0.9 + top_p 0.95 でバラエティを増やす
                    "temperature": 0.9,
                    "top_p": 0.95,
                    "frequency_penalty": 0.3,  # 直近の単語繰り返しを抑制
                    "max_completion_tokens": 2048,
                    # JSON 強制（Groq は OpenAI 互換のフォーマット指定をサポート）
                    "response_format": {"type": "json_object"},
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
            model=self.model,
            input_tokens=usage.get("prompt_tokens"),
            output_tokens=usage.get("completion_tokens"),
        )
