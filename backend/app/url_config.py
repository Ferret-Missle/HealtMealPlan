import os


def clean_url(value: str | None, default: str) -> str:
    cleaned = (value or default).strip().rstrip("/")
    return cleaned or default.rstrip("/")


def get_env_urls(name: str, default: str) -> list[str]:
    raw_value = os.getenv(name, default)
    urls: list[str] = []
    for item in raw_value.split(","):
        cleaned = item.strip().rstrip("/")
        if cleaned and cleaned not in urls:
            urls.append(cleaned)
    return urls or [default.rstrip("/")]


def get_primary_env_url(name: str, default: str) -> str:
    return get_env_urls(name, default)[0]