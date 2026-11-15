# DubCera Local TTS Service (`services/tts-local`)

Local loopback companion service (`http://127.0.0.1:8765`) providing Vietnamese Text-to-Speech synthesis, atomic `SHA-256` WAV caching, RIFF/PCM integrity verification, and hardware profile routing.

## Quick Start (using `uv`)

```powershell
cd services/tts-local
uv sync --extra dev

# Optional: Install local VieNeu-TTS v3 (ONNX CPU / CUDA)
uv pip install vieneu

# Run automated tests
uv run pytest

# Run hardware benchmark on your machine
uv run python scripts/benchmark_hardware.py

# Start local companion service on 127.0.0.1:8765
uv run python -m dubcera_tts.main
```
