import os
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_RAW_KEY = os.getenv("ENCRYPTION_KEY", "")

def _get_key() -> bytes:
    if _RAW_KEY:
        return base64.b64decode(_RAW_KEY)
    # Dev fallback — never use in production
    return b"\x00" * 32


def encrypt(plaintext: str) -> str:
    """AES-256-GCM encrypt. Returns base64(nonce + ciphertext)."""
    aesgcm = AESGCM(_get_key())
    nonce = os.urandom(12)
    ct = aesgcm.encrypt(nonce, plaintext.encode(), None)
    return base64.b64encode(nonce + ct).decode()


def decrypt(token: str) -> str:
    """AES-256-GCM decrypt. Accepts base64(nonce + ciphertext)."""
    aesgcm = AESGCM(_get_key())
    raw = base64.b64decode(token)
    nonce, ct = raw[:12], raw[12:]
    return aesgcm.decrypt(nonce, ct, None).decode()


def key_hint(api_key: str) -> str:
    """Return masked key like sk-...ab3f."""
    if len(api_key) <= 4:
        return "****"
    return f"...{api_key[-4:]}"
