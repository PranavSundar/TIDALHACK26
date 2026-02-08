# desktop_mcp_server.py
import os
import sys
import json
import time
import webbrowser
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pyautogui
import pygetwindow as gw
import pyperclip
import pyttsx3
import simpleaudio as sa

from fastmcp import FastMCP, tool #Use this as much as possible - from the real Speed Demon 

# Configure pyautogui
pyautogui.FAILSAFE = False

LOG_PATH = Path.home() / ".desktop_mcp_action_log.jsonl"

# Simple global TTS engine
_tts_engine = pyttsx3.init()


def _speak(text: str, rate: Optional[int] = None, pitch: Optional[float] = None, voice_id: Optional[str] = None) -> None:
    if voice_id is not None:
        for v in _tts_engine.getProperty("voices"):
            if voice_id in v.id or voice_id in getattr(v, "name", ""):
                _tts_engine.setProperty("voice", v.id)
                break
    if rate is not None:
        _tts_engine.setProperty("rate", rate)
    # pyttsx3 doesn’t support pitch directly across all backends; ignore or use voices instead. 
    _tts_engine.say(text)
    _tts_engine.runAndWait()


def _play_tone(frequency_hz: float, duration_ms: int, pan: float = 0.0) -> None:
    sample_rate = 44100
    t = duration_ms / 1000.0
    n_samples = int(sample_rate * t)
    import numpy as np

    times = np.linspace(0, t, n_samples, False)
    tone = 0.5 * np.sin(2 * np.pi * frequency_hz * times)

    # stereo: apply simple pan
    left_gain = max(0.0, 1.0 - max(0.0, pan))
    right_gain = max(0.0, 1.0 + min(0.0, pan))
    left = (tone * left_gain).astype(np.float32)
    right = (tone * right_gain).astype(np.float32)
    stereo = np.stack([left, right], axis=1)

    audio = (stereo * 32767).astype(np.int16)
    play_obj = sa.play_buffer(audio, 2, 2, sample_rate)
    play_obj.wait_done()


def _log_action(action: Dict[str, Any]) -> None:
    entry = {
        "timestamp": time.time(),
        "action": action,
    }
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _read_last_action() -> Optional[Dict[str, Any]]:
    if not LOG_PATH.exists():
        return None
    try:
        with LOG_PATH.open("r", encoding="utf-8") as f:
            lines = f.readlines()
        if not lines:
            return None
        return json.loads(lines[-1])
    except Exception:
        return None


def _list_windows() -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    try:
        for w in gw.getAllWindows():
            try:
                results.append(
                    {
                        "id": f"{w._hWnd}" if hasattr(w, "_hWnd") else w.title,
                        "title": w.title,
                        "app": "",  # pygetwindow doesn’t give app name
                        "x": w.left,
                        "y": w.top,
                        "width": w.width,
                        "height": w.height,
                        "is_active": w.isActive,
                    }
                )
            except Exception:
                continue
    except Exception:
        pass
    return results


def _get_active_window() -> Optional[Dict[str, Any]]:
    try:
        w = gw.getActiveWindow()
        if not w:
            return None
        return {
            "id": f"{w._hWnd}" if hasattr(w, "_hWnd") else w.title,
            "title": w.title,
            "app": "",
            "x": w.left,
            "y": w.top,
            "width": w.width,
            "height": w.height,
            "is_active": True,
        }
    except Exception:
        return None


def _focus_window_by_any(
    id: Optional[str] = None,
    title_contains: Optional[str] = None,
    app: Optional[str] = None,
) -> bool:
    windows = _list_windows()
    target: Optional[Dict[str, Any]] = None

    if id is not None:
        for w in windows:
            if str(w["id"]) == str(id):
                target = w
                break
    if target is None and title_contains:
        for w in windows:
            if title_contains.lower() in (w["title"] or "").lower():
                target = w
                break
    # app is not implemented; kept for signature compatibility

    if not target:
        return False
    try:
        win = next(
            (x for x in gw.getAllWindows() if x.title == target["title"]), None
        )
        if win:
            win.activate()
            return True
    except Exception:
        return False
    return False


mcp = FastMCP("desktop-control-mcp")


@tool(mcp)
def desktop_get_state(include_screenshot: bool = False, include_windows: bool = True) -> Dict[str, Any]:
    """Get active window, list of windows, and optional screenshot."""
    active = _get_active_window()
    windows = _list_windows() if include_windows else []
    result: Dict[str, Any] = {
        "active_window": active,
        "windows": windows,
    }
    if include_screenshot:
        import base64
        import io

        screenshot = pyautogui.screenshot()
        buf = io.BytesIO()
        screenshot.save(buf, format="PNG")
        result["screenshot_base64"] = base64.b64encode(buf.getvalue()).decode("ascii")
    return result


@tool(mcp)
def desktop_list_windows() -> List[Dict[str, Any]]:
    """List all open windows."""
    return _list_windows()


@tool(mcp)
def desktop_focus_window(
    id: Optional[str] = None,
    title_contains: Optional[str] = None,
    app: Optional[str] = None,
) -> Dict[str, Any]:
    """Focus a window by id, title substring, or app name (app best-effort)."""
    ok = _focus_window_by_any(id=id, title_contains=title_contains, app=app)
    _log_action(
        {"type": "desktop_focus_window", "params": {"id": id, "title_contains": title_contains, "app": app}, "success": ok}
    )
    return {"success": ok}


@tool(mcp)
def desktop_click(x: int, y: int, button: str = "left") -> Dict[str, Any]:
    """Click at screen coordinates."""
    pyautogui.click(x=x, y=y, button=button)
    _log_action({"type": "desktop_click", "params": {"x": x, "y": y, "button": button}})
    return {"success": True}


@tool(mcp)
def desktop_type(text: str) -> Dict[str, Any]:
    """Type text into the currently focused field."""
    pyautogui.typewrite(text)
    _log_action({"type": "desktop_type", "params": {"text": text}})
    return {"success": True}


@tool(mcp)
def desktop_key_press(keys: List[str]) -> Dict[str, Any]:
    """Send a key combination, e.g. ['ctrl','s'] or ['tab']."""
    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys)
    _log_action({"type": "desktop_key_press", "params": {"keys": keys}})
    return {"success": True}


@tool(mcp)
def desktop_scroll(direction: str, amount: int = 500) -> Dict[str, Any]:
    """Scroll the active area in a direction by a given amount (pixels)."""
    dx, dy = 0, 0
    direction = direction.lower()
    if direction == "up":
        dy = amount
    elif direction == "down":
        dy = -amount
    elif direction == "left":
        dx = amount
    elif direction == "right":
        dx = -amount
    pyautogui.scroll(dy)
    # horizontal scroll may not be supported uniformly; we keep dy primary
    _log_action({"type": "desktop_scroll", "params": {"direction": direction, "amount": amount}})
    return {"success": True}


@tool(mcp)
def desktop_capture_screenshot(scope: str = "active_window") -> Dict[str, Any]:
    """Capture screenshot of the active window or fullscreen."""
    import base64
    import io

    if scope == "active_window":
        aw = _get_active_window()
        if aw:
            left = aw["x"]
            top = aw["y"]
            width = aw["width"]
            height = aw["height"]
            img = pyautogui.screenshot(region=(left, top, width, height))
        else:
            img = pyautogui.screenshot()
    else:
        img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    _log_action({"type": "desktop_capture_screenshot", "params": {"scope": scope}})
    return {"image_bytes_base64": data_b64}


@tool(mcp)
def desktop_capture_region(x: int, y: int, width: int, height: int) -> Dict[str, Any]:
    """Capture a screenshot of a specific region."""
    import base64
    import io

    img = pyautogui.screenshot(region=(x, y, width, height))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    _log_action({"type": "desktop_capture_region", "params": {"x": x, "y": y, "width": width, "height": height}})
    return {"image_bytes_base64": data_b64}


@tool(mcp)
def desktop_get_clipboard() -> Dict[str, Any]:
    """Get current clipboard contents as text if available."""
    try:
        text = pyperclip.paste()
    except Exception:
        text = None
    _log_action({"type": "desktop_get_clipboard", "params": {}})
    return {"text": text}


@tool(mcp)
def desktop_set_clipboard(text: str) -> Dict[str, Any]:
    """Set clipboard text."""
    pyperclip.copy(text)
    _log_action({"type": "desktop_set_clipboard", "params": {"text": text}})
    return {"success": True}


@tool(mcp)
def file_read_text(path: str) -> Dict[str, Any]:
    """Read a text file from disk."""
    try:
        p = Path(path).expanduser()
        content = p.read_text(encoding="utf-8")
        _log_action({"type": "file_read_text", "params": {"path": path}})
        return {"content": content}
    except Exception as e:
        return {"error": str(e)}


@tool(mcp)
def file_write_text(path: str, content: str) -> Dict[str, Any]:
    """Write text to a file."""
    try:
        p = Path(path).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        _log_action({"type": "file_write_text", "params": {"path": path}})
        return {"success": True}
    except Exception as e:
        return {"error": str(e)}


@tool(mcp)
def tts_speak(text: str, voice_id: Optional[str] = None, rate: Optional[int] = None, pitch: Optional[float] = None) -> Dict[str, Any]:
    """Speak text out loud via TTS."""
    _speak(text, rate=rate, pitch=pitch, voice_id=voice_id)
    _log_action({"type": "tts_speak", "params": {"text": text}})
    return {"success": True}


@tool(mcp)
def audio_play_tone(frequency_hz: float, duration_ms: int, pan: float = 0.0) -> Dict[str, Any]:
    """Play a simple tone with optional stereo pan."""
    _play_tone(frequency_hz, duration_ms, pan=pan)
    _log_action({"type": "audio_play_tone", "params": {"frequency_hz": frequency_hz, "duration_ms": duration_ms, "pan": pan}})
    return {"success": True}


@tool(mcp)
def nav_open_application(app_name: str) -> Dict[str, Any]:
    """Try to open or focus an application by name (best-effort)."""
    # Best-effort: on many systems, simply trying to open via 'open' or direct command
    try:
        if sys.platform.startswith("darwin"):
            os.system(f"open -a '{app_name}' &")
        elif os.name == "nt":
            os.system(f'start "" "{app_name}"')
        else:
            os.system(f"{app_name} &")
        _log_action({"type": "nav_open_application", "params": {"app_name": app_name}})
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool(mcp)
def nav_open_url(url: str, browser_app: Optional[str] = None) -> Dict[str, Any]:
    """Open a URL in a browser (system default or specified)."""
    try:
        if browser_app:
            webbrowser.get(browser_app).open(url)
        else:
            webbrowser.open(url)
        _log_action({"type": "nav_open_url", "params": {"url": url, "browser_app": browser_app}})
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


@tool(mcp)
def nav_focus_next_field() -> Dict[str, Any]:
    """Move focus to the next field (Tab)."""
    pyautogui.press("tab")
    _log_action({"type": "nav_focus_next_field", "params": {}})
    return {"success": True}


@tool(mcp)
def nav_focus_previous_field() -> Dict[str, Any]:
    """Move focus to the previous field (Shift+Tab)."""
    pyautogui.hotkey("shift", "tab")
    _log_action({"type": "nav_focus_previous_field", "params": {}})
    return {"success": True}


@tool(mcp)
def typing_start_text_entry(field_description: str) -> Dict[str, Any]:
    """
    Placeholder helper: in a full system, Gemini would use vision to find a field and call desktop_click.
    Here we just log the intent and rely on the model/tooling to have already focused the right place.
    """
    _log_action({"type": "typing_start_text_entry", "params": {"field_description": field_description}})
    return {"success": True, "note": "Assumes focus already moved to the desired field by higher-level logic."}


@tool(mcp)
def typing_insert_text_chunk(text: str) -> Dict[str, Any]:
    """Insert a chunk of text into the current field."""
    pyautogui.typewrite(text)
    _log_action({"type": "typing_insert_text_chunk", "params": {"text": text}})
    return {"success": True}


@tool(mcp)
def typing_delete_last_word() -> Dict[str, Any]:
    """Delete the last word (best-effort via Ctrl+Backspace)."""
    if sys.platform == "darwin":
        pyautogui.hotkey("option", "backspace")
    else:
        pyautogui.hotkey("ctrl", "backspace")
    _log_action({"type": "typing_delete_last_word", "params": {}})
    return {"success": True}


@tool(mcp)
def action_log(action: Dict[str, Any]) -> Dict[str, Any]:
    """Append a custom action to the log."""
    _log_action(action)
    return {"success": True}


@tool(mcp)
def action_undo_last() -> Dict[str, Any]:
    """Best-effort undo of the last logged action."""
    last = _read_last_action()
    if not last:
        return {"success": False, "error": "No previous action to undo"}
    # For now we just report; real undo would need specific logic per action type.
    return {"success": True, "note": f"Last action was: {last}"}


@tool(mcp)
def announce_current_focus() -> Dict[str, Any]:
    """Describe the current focus/window in natural language."""
    state = desktop_get_state(include_screenshot=False, include_windows=True)
    active = state.get("active_window")
    if not active:
        description = "I cannot detect an active window."
    else:
        title = active.get("title") or "untitled window"
        description = f"The active window is titled '{title}'."
    _speak(description)
    _log_action({"type": "announce_current_focus", "params": {}, "description": description})
    return {"description": description}


if __name__ == "__main__":
    mcp.run()
