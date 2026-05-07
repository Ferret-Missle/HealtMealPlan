from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class LLMResponse:
    text: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None


class LLMAdapter(ABC):
    supports_vision: bool = False

    @abstractmethod
    async def complete(self, system: str, user: str) -> LLMResponse:
        ...

    async def complete_vision(self, system: str, user: str, image_b64: str, mime: str) -> LLMResponse:
        raise NotImplementedError("This provider does not support vision")


def get_adapter(plan_type: str, byok_provider: str | None, api_key: str | None, model: str | None = None) -> LLMAdapter:
    if plan_type == "byok" and byok_provider and api_key:
        return _get_byok_adapter(byok_provider, api_key, model)
    # Free plan
    from .groq_adapter import GroqAdapter
    import os
    groq_key = os.getenv("GROQ_API_KEY", "")
    return GroqAdapter(groq_key, model)


def _get_byok_adapter(provider: str, api_key: str, model: str | None = None) -> LLMAdapter:
    if provider == "anthropic":
        from .anthropic_byok import AnthropicBYOKAdapter
        return AnthropicBYOKAdapter(api_key, model)
    elif provider == "openai":
        from .openai_byok import OpenAIBYOKAdapter
        return OpenAIBYOKAdapter(api_key, model)
    elif provider == "gemini":
        from .gemini_byok import GeminiBYOKAdapter
        return GeminiBYOKAdapter(api_key, model)
    elif provider == "groq":
        from .groq_adapter import GroqAdapter
        return GroqAdapter(api_key, model)
    elif provider == "mistral":
        from .mistral_byok import MistralBYOKAdapter
        return MistralBYOKAdapter(api_key, model)
    else:
        raise ValueError(f"Unknown BYOK provider: {provider}")


# プロバイダーごとの利用可能モデル（フロントへ提供）
AVAILABLE_MODELS = {
    "anthropic": [
        {"id": "claude-sonnet-4-5", "label": "Claude Sonnet 4.5（標準）"},
        {"id": "claude-opus-4-1", "label": "Claude Opus 4.1（高品質・高コスト）"},
        {"id": "claude-haiku-4-5", "label": "Claude Haiku 4.5（高速・低コスト）"},
    ],
    "openai": [
        {"id": "gpt-4o-mini", "label": "GPT-4o mini（標準・低コスト）"},
        {"id": "gpt-4o", "label": "GPT-4o（高品質）"},
        {"id": "gpt-4-turbo", "label": "GPT-4 Turbo"},
    ],
    "gemini": [
        {"id": "gemini-1.5-flash", "label": "Gemini 1.5 Flash（標準）"},
        {"id": "gemini-1.5-pro", "label": "Gemini 1.5 Pro（高品質）"},
        {"id": "gemini-2.0-flash-exp", "label": "Gemini 2.0 Flash（実験版）"},
    ],
    "groq": [
        {"id": "llama-3.3-70b-versatile", "label": "Llama 3.3 70B（標準）"},
        {"id": "llama-3.1-8b-instant", "label": "Llama 3.1 8B（高速）"},
        {"id": "mixtral-8x7b-32768", "label": "Mixtral 8x7B"},
    ],
    "mistral": [
        {"id": "mistral-large-latest", "label": "Mistral Large（標準）"},
        {"id": "mistral-medium-latest", "label": "Mistral Medium"},
        {"id": "ministral-8b-latest", "label": "Ministral 8B（高速）"},
    ],
    # 無料プランのデフォルト（Groq）でも選択可
    "free": [
        {"id": "llama-3.3-70b-versatile", "label": "Llama 3.3 70B（標準）"},
        {"id": "llama-3.1-8b-instant", "label": "Llama 3.1 8B（高速）"},
    ],
}
