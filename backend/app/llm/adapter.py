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


def get_adapter(plan_type: str, byok_provider: str | None, api_key: str | None) -> LLMAdapter:
    if plan_type == "byok" and byok_provider and api_key:
        return _get_byok_adapter(byok_provider, api_key)
    # Free plan
    from .groq_adapter import GroqAdapter
    import os
    groq_key = os.getenv("GROQ_API_KEY", "")
    return GroqAdapter(groq_key)


def _get_byok_adapter(provider: str, api_key: str) -> LLMAdapter:
    if provider == "anthropic":
        from .anthropic_byok import AnthropicBYOKAdapter
        return AnthropicBYOKAdapter(api_key)
    elif provider == "openai":
        from .openai_byok import OpenAIBYOKAdapter
        return OpenAIBYOKAdapter(api_key)
    elif provider == "gemini":
        from .gemini_byok import GeminiBYOKAdapter
        return GeminiBYOKAdapter(api_key)
    elif provider == "groq":
        from .groq_adapter import GroqAdapter
        return GroqAdapter(api_key)
    elif provider == "mistral":
        from .mistral_byok import MistralBYOKAdapter
        return MistralBYOKAdapter(api_key)
    else:
        raise ValueError(f"Unknown BYOK provider: {provider}")
