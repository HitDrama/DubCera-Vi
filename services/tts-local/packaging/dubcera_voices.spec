# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = []
binaries = []
hiddenimports = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "fastapi",
    "starlette",
    "pydantic",
    "anyio._backends._asyncio",
    "dubcera_tts",
    "dubcera_tts.main",
    "dubcera_tts.engines.vieneu_onnx",
    "dubcera_tts.engines.sherpa_piper",
    "dubcera_tts.engines.mock_tone",
    "dubcera_tts.engines.registry",
]

for pkg in [
    "vieneu",
    "sea_g2p",
    "onnxruntime",
    "soundfile",
    "soxr",
    "librosa",
    "tokenizers",
    "huggingface_hub",
    "miniaudio",
]:
    try:
        pkg_datas, pkg_binaries, pkg_hidden = collect_all(pkg)
        datas += pkg_datas
        binaries += pkg_binaries
        hiddenimports += pkg_hidden
    except Exception:
        pass

hiddenimports += collect_submodules("dubcera_tts")

a = Analysis(
    ["../src/dubcera_tts/launcher.py"],
    pathex=["../src"],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "gradio",
        "gradio_client",
        "pytest",
        "_pytest",
        "tkinter",
        "matplotlib",
        "IPython",
        "notebook",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="DubCeraVoices",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="DubCeraVoices",
)
