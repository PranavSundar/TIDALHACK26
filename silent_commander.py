import sys
import webbrowser
import urllib.parse
import subprocess
import platform
import re
import os

class SilentCommander:
    def __init__(self):
        self.os_type = platform.system().lower()
        self.site_whitelist = {
            "youtube": "https://www.youtube.com",
            "gmail": "https://mail.google.com",
            "google": "https://www.google.com",
            "reddit": "https://www.reddit.com",
            "github": "https://github.com",
            "amazon": "https://www.amazon.com",
            "netflix": "https://www.netflix.com",
            "twitter": "https://twitter.com",
            "x": "https://x.com",
            "facebook": "https://www.facebook.com",
            "linkedin": "https://www.linkedin.com",
            "wikipedia": "https://www.wikipedia.org",
            "weather": "https://weather.com",
            "news": "https://news.google.com"
        }

    def execute(self, transcription: str) -> None:
        """
        Parses and executes commands silently.
        """
        if not transcription:
            return

        # Split multi-step commands (e.g., "open youtube and search cats")
        parts = re.split(r'\b(?:and|then)\b', transcription, flags=re.IGNORECASE)
        
        for part in parts:
            clean_cmd = part.strip().lower()
            if not clean_cmd:
                continue
            self._dispatch(clean_cmd)

    def _dispatch(self, command: str) -> None:
        # Search Intent
        if command.startswith("search") or command.startswith("find"):
            self._handle_search(command)
        # Open Intent
        elif command.startswith("open"):
            self._handle_open(command)

    def _handle_search(self, command: str) -> None:
        # Extract query: "search for cats" -> "cats"
        query = re.sub(r'^(?:search|find)(?:\s+for)?\s+', '', command).strip()
        if query:
            url = f"https://www.google.com/search?q={urllib.parse.quote(query)}"
            self._open_browser(url)

    def _handle_open(self, command: str) -> None:
        target = re.sub(r'^open\s+', '', command).strip()
        
        # System Settings
        if "setting" in target or "control panel" in target:
            self._open_system_settings(target)
            return

        # Whitelisted Sites
        for key, url in self.site_whitelist.items():
            if key in target:
                self._open_browser(url)
                return

    def _open_browser(self, url: str) -> None:
        try:
            webbrowser.open_new_tab(url)
        except Exception:
            pass

    def _open_system_settings(self, target: str) -> None:
        try:
            if "windows" in self.os_type:
                self._win_settings(target)
            elif "darwin" in self.os_type:
                self._mac_settings(target)
            elif "linux" in self.os_type:
                self._linux_settings(target)
        except Exception:
            pass

    def _win_settings(self, target: str) -> None:
        # Windows 10/11 URI schemes
        uri = "ms-settings:"
        if any(w in target for w in ["sound", "audio", "volume"]):
            uri = "ms-settings:sound"
        elif any(w in target for w in ["display", "screen", "monitor"]):
            uri = "ms-settings:display"
        elif any(w in target for w in ["privacy", "security"]):
            uri = "ms-settings:privacy"
        elif any(w in target for w in ["bluetooth", "device"]):
            uri = "ms-settings:bluetooth"
        elif any(w in target for w in ["wifi", "network", "internet"]):
            uri = "ms-settings:network"
        elif any(w in target for w in ["power", "battery", "sleep"]):
            uri = "ms-settings:powersleep"
        
        # os.startfile is Windows-specific and handles URIs correctly
        if hasattr(os, 'startfile'):
            os.startfile(uri)
        else:
            subprocess.run(["start", uri], shell=True)

    def _mac_settings(self, target: str) -> None:
        # macOS Preference Panes
        uri = "x-apple.systempreferences:"
        if any(w in target for w in ["sound", "audio", "volume"]):
            uri += "com.apple.preference.sound"
        elif any(w in target for w in ["display", "screen", "monitor"]):
            uri += "com.apple.preference.displays"
        elif any(w in target for w in ["privacy", "security"]):
            uri += "com.apple.preference.security?Privacy"
        elif any(w in target for w in ["network", "wifi", "internet"]):
            uri += "com.apple.preference.network"
        elif any(w in target for w in ["update"]):
            uri += "com.apple.preferences.softwareupdate"
            
        subprocess.run(["open", uri])

    def _linux_settings(self, target: str) -> None:
        # Attempt to use gnome-control-center as a common fallback
        cmd = ["gnome-control-center"]
        
        if any(w in target for w in ["sound", "audio", "volume"]):
            cmd.append("sound")
        elif any(w in target for w in ["display", "screen", "monitor"]):
            cmd.append("display")
        elif any(w in target for w in ["network", "wifi"]):
            cmd.append("network")
        elif any(w in target for w in ["bluetooth"]):
            cmd.append("bluetooth")
        elif any(w in target for w in ["power"]):
            cmd.append("power")
            
        subprocess.run(cmd)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        commander = SilentCommander()
        commander.execute(" ".join(sys.argv[1:]))
