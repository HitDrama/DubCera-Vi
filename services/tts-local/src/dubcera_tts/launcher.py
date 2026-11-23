from __future__ import annotations

import argparse
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from dubcera_tts.config import ServiceConfig

DEFAULT_EXTENSION_ID = "agjbmkobficdohbngajcmfhggabapncl"
NATIVE_HOST_NAME = "com.dubcera.voices"
STARTUP_REG_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
STARTUP_VALUE_NAME = "DubCeraVoices"
NATIVE_HOST_REG_KEYS = (
    rf"Software\Google\Chrome\NativeMessagingHosts\{NATIVE_HOST_NAME}",
    rf"Software\Microsoft\Edge\NativeMessagingHosts\{NATIVE_HOST_NAME}",
)


def is_server_already_running(host: str, port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/v1/health", timeout=1.0) as resp:
            return resp.status == 200
    except Exception:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.4)
            return sock.connect_ex((host, port)) == 0


def configure_background_logging(cfg: ServiceConfig) -> None:
    log_dir = cfg.cache_dir.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "dubcera_voices.log"
    stream = open(log_file, "a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream


def set_windows_autostart(enable: bool) -> str:
    if sys.platform != "win32":
        return "Auto-start is only supported on Windows."
    import winreg

    exe_path = Path(sys.executable).resolve()
    command = f'"{exe_path}" --background --idle-shutdown 0'

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, STARTUP_REG_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enable:
            winreg.SetValueEx(key, STARTUP_VALUE_NAME, 0, winreg.REG_SZ, command)
            return f"Enabled Windows auto-start: {command}"
        try:
            winreg.DeleteValue(key, STARTUP_VALUE_NAME)
            return "Disabled Windows auto-start for DubCeraVoices."
        except FileNotFoundError:
            return "Windows auto-start was already disabled."


def register_native_host(extension_ids: list[str]) -> str:
    if sys.platform != "win32":
        return "Native host registration is only supported on Windows."
    import winreg

    exe_path = Path(sys.executable).resolve()
    app_dir = exe_path.parent
    bridge_bat = app_dir / "dubcera-native-host.bat"
    manifest_path = app_dir / f"{NATIVE_HOST_NAME}.json"

    if getattr(sys, "frozen", False):
        bridge_cmd = f'@echo off\r\n"{exe_path}" --native-host\r\n'
    else:
        bridge_cmd = f'@echo off\r\n"{exe_path}" -m dubcera_tts.launcher --native-host\r\n'
    bridge_bat.write_text(bridge_cmd, encoding="ascii")

    clean_ids = [eid.strip() for eid in extension_ids if eid.strip()]
    if not clean_ids:
        clean_ids = [DEFAULT_EXTENSION_ID]

    manifest = {
        "name": NATIVE_HOST_NAME,
        "description": "DubCera On-Demand VieNeu Local TTS Host",
        "path": str(bridge_bat),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{eid}/" for eid in clean_ids],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    for reg_path in NATIVE_HOST_REG_KEYS:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path) as key:
            winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_path))

    return (
        f"Registered Native Messaging Host ({NATIVE_HOST_NAME}) for Chrome & Edge:\n"
        f"  Manifest: {manifest_path}\n"
        f"  Bridge:   {bridge_bat}\n"
        f"  Allowed:  {', '.join(clean_ids)}"
    )


def unregister_native_host() -> str:
    if sys.platform != "win32":
        return "Native host unregistration is only supported on Windows."
    import winreg

    removed = 0
    for reg_path in NATIVE_HOST_REG_KEYS:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, reg_path)
            removed += 1
        except FileNotFoundError:
            pass
    return f"Removed {removed} Native Messaging Host registry entries ({NATIVE_HOST_NAME})."


def _read_native_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0 or msg_len > 1_048_576:
        return None
    raw_body = sys.stdin.buffer.read(msg_len)
    if not raw_body:
        return None
    return json.loads(raw_body.decode("utf-8"))


def _write_native_message(payload: dict) -> None:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _spawn_detached_server(idle_shutdown_seconds: int) -> None:
    exe_path = Path(sys.executable).resolve()
    if getattr(sys, "frozen", False):
        cmd = [str(exe_path), "--background", "--idle-shutdown", str(idle_shutdown_seconds)]
    else:
        cmd = [
            str(exe_path),
            "-m",
            "dubcera_tts.launcher",
            "--background",
            "--idle-shutdown",
            str(idle_shutdown_seconds),
        ]

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        )

    subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=creationflags,
    )


def run_native_host() -> None:
    cfg = ServiceConfig.from_env()
    try:
        msg = _read_native_message()
        if not msg or not isinstance(msg, dict):
            _write_native_message({"ok": False, "error": "Empty native message"})
            return

        action = str(msg.get("action", "ensure_running"))
        idle_sec = int(msg.get("idleShutdownSeconds", 180))

        if action == "status":
            _write_native_message(
                {"ok": True, "running": is_server_already_running(cfg.host, cfg.port)}
            )
            return

        if action == "ensure_running":
            if is_server_already_running(cfg.host, cfg.port):
                _write_native_message({"ok": True, "status": "already_running"})
                return

            _spawn_detached_server(max(60, idle_sec))
            deadline = time.monotonic() + 18.0
            while time.monotonic() < deadline:
                if is_server_already_running(cfg.host, cfg.port):
                    _write_native_message({"ok": True, "status": "started"})
                    return
                time.sleep(0.25)

            _write_native_message({"ok": False, "error": "Timed out waiting for TTS server health"})
            return

        _write_native_message({"ok": False, "error": f"Unknown action: {action}"})
    except Exception as exc:
        _write_native_message({"ok": False, "error": str(exc)})


def main() -> None:
    parser = argparse.ArgumentParser(description="DubCera Local VieNeu Voice Server")
    parser.add_argument(
        "--background",
        action="store_true",
        help="Run silently with logs redirected to %%LOCALAPPDATA%%\\DubCera\\logs",
    )
    parser.add_argument(
        "--idle-shutdown",
        type=int,
        default=-1,
        help="Auto-exit process after N idle seconds (0 disables; default 180 in --background)",
    )
    parser.add_argument(
        "--native-host",
        action="store_true",
        help="Run as Chrome/Edge Native Messaging Host (stdio JSON protocol)",
    )
    parser.add_argument(
        "--register-native-host",
        action="store_true",
        help="Register DubCeraVoices as Chrome & Edge Native Messaging Host (on-demand auto-start)",
    )
    parser.add_argument(
        "--unregister-native-host",
        action="store_true",
        help="Remove Chrome & Edge Native Messaging Host registration",
    )
    parser.add_argument(
        "--extension-id",
        action="append",
        default=[],
        help="Allowed Chrome/Edge extension ID (defaults to pinned DubCera ID)",
    )
    parser.add_argument(
        "--install-startup",
        action="store_true",
        help="Register DubCeraVoices to auto-start silently with Windows",
    )
    parser.add_argument(
        "--uninstall-startup",
        action="store_true",
        help="Remove DubCeraVoices from Windows auto-start",
    )
    args = parser.parse_args()

    if args.native_host:
        run_native_host()
        return
    if args.register_native_host:
        print(register_native_host(args.extension_id or [DEFAULT_EXTENSION_ID]))
        return
    if args.unregister_native_host:
        print(unregister_native_host())
        return
    if args.install_startup:
        print(set_windows_autostart(True))
        return
    if args.uninstall_startup:
        print(set_windows_autostart(False))
        return

    idle_sec = args.idle_shutdown if args.idle_shutdown >= 0 else (180 if args.background else 0)
    os.environ["DUBCERA_IDLE_SHUTDOWN_SECONDS"] = str(idle_sec)

    cfg = ServiceConfig.from_env()

    if args.background or sys.stdout is None or sys.stderr is None:
        configure_background_logging(cfg)

    if is_server_already_running(cfg.host, cfg.port):
        print(f"[DubCeraVoices] Server is already running on http://{cfg.host}:{cfg.port}")
        return

    print("==========================================================")
    print(f"  DubCera Voices Server running on http://{cfg.host}:{cfg.port}")
    print(f"  Cache dir: {cfg.cache_dir}")
    if idle_sec > 0:
        print(f"  Auto-shutdown after {idle_sec}s idle (0 MB RAM when not watching)")
    else:
        print("  Auto-releases model RAM (~50MB) after 60s idle")
    print("==========================================================")

    import uvicorn
    from dubcera_tts.main import app

    uvicorn.run(
        app,
        host=cfg.host,
        port=cfg.port,
        reload=False,
        log_level="warning" if args.background else "info",
    )


if __name__ == "__main__":
    main()
