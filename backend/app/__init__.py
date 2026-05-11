from pathlib import Path

from dotenv import load_dotenv


def _load_local_env_files() -> None:
	backend_dir = Path(__file__).resolve().parent.parent
	root_dir = backend_dir.parent
	for env_path in (
		backend_dir / ".env",
		backend_dir / ".env.local",
		backend_dir / ".env.render.local",
		root_dir / ".env",
		root_dir / ".env.local",
	):
		if env_path.exists():
			load_dotenv(env_path, override=False)


_load_local_env_files()
