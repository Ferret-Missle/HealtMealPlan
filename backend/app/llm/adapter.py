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
    async def complete(self, system: str, user: str, json_mode: bool = False) -> LLMResponse:
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


USD_TO_JPY = 155.0


def _yen(value: float | None) -> float | None:
    if value is None:
        return None
    return round(value * USD_TO_JPY, 2)


def _yen_label(value: float | None) -> str | None:
    if value is None:
        return None
    if float(value).is_integer():
        return f"¥{int(value):,}"
    return f"¥{value:,.2f}"


def _model_entry(
    provider: str,
    model_id: str,
    label: str,
    input_usd_per_1m: float | None = None,
    output_usd_per_1m: float | None = None,
) -> dict:
    input_jpy = _yen(input_usd_per_1m)
    output_jpy = _yen(output_usd_per_1m)
    entry = {
        "id": model_id,
        "provider": provider,
        "label": label,
        "input_cost_jpy_per_1m": input_jpy,
        "output_cost_jpy_per_1m": output_jpy,
    }
    if input_jpy is not None and output_jpy is not None:
        entry["pricing_note"] = f"入力 {_yen_label(input_jpy)} / 出力 {_yen_label(output_jpy)} / 1M tok"
    return entry


_MODEL_GROUPS = {
    "anthropic": [
        _model_entry("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6（標準）", 3.0, 15.0),
        _model_entry("anthropic", "claude-opus-4-7", "Claude Opus 4.7（高品質）", 5.0, 25.0),
        _model_entry("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5（高速）", 1.0, 5.0),
    ],
    "openai": [
        _model_entry("openai", "gpt-5.4-mini", "GPT-5.4 mini（標準・低コスト）", 0.75, 4.5),
        _model_entry("openai", "gpt-5.4", "GPT-5.4（高品質）", 2.5, 15.0),
        _model_entry("openai", "gpt-5.5", "GPT-5.5（最上位）", 5.0, 30.0),
    ],
    "gemini": [
        _model_entry("gemini", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite（最安）", 0.10, 0.40),
        _model_entry("gemini", "gemini-2.5-flash", "Gemini 2.5 Flash（標準）", 0.30, 2.50),
        _model_entry("gemini", "gemini-2.5-pro", "Gemini 2.5 Pro（高品質）", 1.25, 10.0),
    ],
    "groq": [
        _model_entry("groq", "llama-3.3-70b-versatile", "Llama 3.3 70B（標準）", 0.59, 0.79),
        _model_entry("groq", "llama-3.1-8b-instant", "Llama 3.1 8B（高速）", 0.05, 0.08),
        _model_entry("groq", "llama-4-scout-17b-16e-instruct", "Llama 4 Scout（新しめ）", 0.11, 0.34),
    ],
    "mistral": [
        _model_entry("mistral", "mistral-large-latest", "Mistral Large（標準）"),
        _model_entry("mistral", "mistral-medium-latest", "Mistral Medium"),
        _model_entry("mistral", "ministral-8b-latest", "Ministral 8B（高速）"),
    ],
}


AVAILABLE_MODELS = {
    **_MODEL_GROUPS,
    "free": [
        dict(item)
        for item in _MODEL_GROUPS["groq"]
    ],
}

MODEL_METADATA_BY_ID = {
    item["id"]: item
    for models in AVAILABLE_MODELS.values()
    for item in models
}


def get_model_metadata(model_id: str | None) -> dict | None:
    if not model_id:
        return None
    return MODEL_METADATA_BY_ID.get(model_id)


def estimate_model_cost_jpy(
    model_id: str | None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
) -> dict:
    meta = get_model_metadata(model_id)
    result = {
        "input_cost_jpy_per_1m": meta.get("input_cost_jpy_per_1m") if meta else None,
        "output_cost_jpy_per_1m": meta.get("output_cost_jpy_per_1m") if meta else None,
        "pricing_note": meta.get("pricing_note") if meta else None,
        "estimated_input_cost_jpy": None,
        "estimated_output_cost_jpy": None,
        "estimated_total_cost_jpy": None,
    }
    if not meta:
        return result
    subtotal = 0.0
    has_cost = False
    if input_tokens is not None and meta.get("input_cost_jpy_per_1m") is not None:
        result["estimated_input_cost_jpy"] = round(
            meta["input_cost_jpy_per_1m"] * input_tokens / 1_000_000,
            4,
        )
        subtotal += result["estimated_input_cost_jpy"]
        has_cost = True
    if output_tokens is not None and meta.get("output_cost_jpy_per_1m") is not None:
        result["estimated_output_cost_jpy"] = round(
            meta["output_cost_jpy_per_1m"] * output_tokens / 1_000_000,
            4,
        )
        subtotal += result["estimated_output_cost_jpy"]
        has_cost = True
    if has_cost:
        result["estimated_total_cost_jpy"] = round(subtotal, 4)
    return result
