"""Select a regular Chrome for the managed shared browser.

Chrome for Testing is useful for isolated tests, but the shared browser must not
quietly inherit it from the older Playwright browser configuration.
"""

import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.request import urlopen


REPOSITORY = "https://dl.google.com/linux/chrome/deb/"
INDEX = REPOSITORY + "dists/stable/main/binary-amd64/Packages.gz"
MAX_INDEX = 8_000_000
MAX_INDEX_CONTENT = 40_000_000
MAX_PACKAGE = 300_000_000


def product(executable):
    path = Path(executable).expanduser()
    if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
        return None
    try:
        result = subprocess.run([str(path), "--version"], capture_output=True,
                                text=True, timeout=10, check=True)
    except (OSError, subprocess.SubprocessError):
        return None
    version = result.stdout.strip()
    if re.match(r"^Google Chrome \d+\.", version):
        return "chrome"
    if re.match(r"^Chromium \d+\.", version):
        return "chromium"
    if "Chrome for Testing" in version:
        return "testing"
    return None


def package_record(index):
    for paragraph in index.split("\n\n"):
        if not paragraph.startswith("Package: google-chrome-stable\n"):
            continue
        fields = dict(line.split(": ", 1) for line in paragraph.splitlines()
                      if ": " in line and not line.startswith(" "))
        version = fields.get("Version", "")
        filename = fields.get("Filename", "")
        digest = fields.get("SHA256", "")
        size = fields.get("Size", "")
        if (not re.fullmatch(r"[a-zA-Z0-9.+~-]+", version)
                or not re.fullmatch(r"pool/main/g/google-chrome-stable/google-chrome-stable_[a-zA-Z0-9.+~-]+_amd64\.deb", filename)
                or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not size.isdecimal() or not 1 <= int(size) <= MAX_PACKAGE):
            raise ValueError("Invalid official Chrome package metadata")
        return version, filename, digest, int(size)
    raise ValueError("Official Chrome stable package is missing")


def install_official(home, *, fetch=urlopen):
    if platform.machine() not in ("x86_64", "AMD64"):
        raise RuntimeError("Google Chrome for Linux is unavailable on this CPU; use a regular supported browser or attached Chrome")
    os_release = Path("/etc/os-release").read_text()
    if not re.search(r'(?m)^ID=(?:"?)(?:ubuntu|debian)(?:"?)$', os_release):
        raise RuntimeError("Automatic Google Chrome installation requires Ubuntu or Debian")
    if not shutil.which("dpkg-deb"):
        raise RuntimeError("Install dpkg-deb before installing regular Google Chrome")
    with fetch(INDEX, timeout=30) as response:
        compressed = response.read(MAX_INDEX + 1)
    if len(compressed) > MAX_INDEX:
        raise ValueError("Official Chrome package index is too large")
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as archive:
        content = archive.read(MAX_INDEX_CONTENT + 1)
    if len(content) > MAX_INDEX_CONTENT:
        raise ValueError("Official Chrome package index expands too far")
    version, filename, digest, size = package_record(content.decode())
    root = Path(home) / ".local/share/dev-tools-google-chrome"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = root / version
    binary = destination / "opt/google/chrome/chrome"
    if product(binary) == "chrome":
        (binary.parent / "chrome-sandbox").unlink(missing_ok=True)
        return binary
    with tempfile.TemporaryDirectory(prefix="download-", dir=root) as temporary:
        package = Path(temporary) / "chrome.deb"
        checksum = hashlib.sha256()
        received = 0
        with fetch(REPOSITORY + filename, timeout=60) as response, package.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                received += len(chunk)
                if received > size:
                    raise ValueError("Official Chrome package exceeds its published size")
                checksum.update(chunk)
                output.write(chunk)
        if received != size or checksum.hexdigest() != digest:
            raise ValueError("Official Chrome package failed SHA256 verification")
        extracted = Path(temporary) / "extracted"
        subprocess.run(["dpkg-deb", "-x", str(package), str(extracted)],
                       check=True, timeout=120, capture_output=True)
        if product(extracted / "opt/google/chrome/chrome") != "chrome":
            raise RuntimeError("Downloaded package does not contain regular Google Chrome")
        # The .deb's setuid helper is unusable when extracted by an ordinary
        # user. Chrome instead uses its user namespace sandbox, which the
        # provisioner's sandbox probe verifies and repairs where needed.
        (extracted / "opt/google/chrome/chrome-sandbox").unlink(missing_ok=True)
        if destination.exists():
            raise RuntimeError("Existing Chrome installation is incomplete; inspect " + str(destination))
        extracted.rename(destination)
    return binary


def install_chromium():
    """Use the distribution's standard Chromium package on Linux ARM64."""
    release = Path("/etc/os-release").read_text()
    if re.search(r'(?m)^ID=(?:"?)(?:ubuntu)(?:"?)$', release):
        if not shutil.which("snap"):
            raise RuntimeError("Ubuntu ARM64 needs snapd to install standard Chromium")
        subprocess.run(["sudo", "-n", "snap", "install", "chromium"],
                       check=True, timeout=600)
        candidate = Path("/snap/bin/chromium")
    elif re.search(r'(?m)^ID=(?:"?)(?:debian)(?:"?)$', release):
        subprocess.run(["sudo", "-n", "apt-get", "install", "-y", "chromium"],
                       check=True, timeout=600)
        candidate = Path(shutil.which("chromium") or "/usr/bin/chromium")
    else:
        raise RuntimeError("Automatic Chromium installation requires Ubuntu or Debian")
    if product(candidate) != "chromium":
        raise RuntimeError("The distribution package did not provide standard Chromium")
    return candidate


def save_selection(home, binary):
    config = Path(home) / ".config/dev-tools/shared-browser.json"
    if config.is_symlink():
        raise RuntimeError("Refusing to replace a symlinked shared-browser configuration")
    config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    current = json.loads(config.read_text()) if config.exists() else {}
    if not isinstance(current, dict):
        raise ValueError("Shared-browser configuration must be a JSON object")
    current["chrome"] = str(binary)
    with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, prefix=".shared-browser-",
                                     delete=False) as output:
        temporary = Path(output.name)
        os.chmod(temporary, 0o600)
        json.dump(current, output, indent=2)
        output.write("\n")
    temporary.replace(config)


def resolve(home=Path.home(), *, installer=install_official, arm_installer=install_chromium):
    home = Path(home)
    arm = platform.machine() in ("aarch64", "arm64")
    allowed = {"chrome", "chromium"} if arm else {"chrome"}
    explicit = os.environ.get("SHARED_BROWSER_CHROME", "")
    if explicit:
        if product(explicit) not in allowed:
            raise RuntimeError("SHARED_BROWSER_CHROME must point to regular Google Chrome (or standard Chromium on ARM64), never Chrome for Testing")
        return Path(explicit)
    config = home / ".config/dev-tools/shared-browser.json"
    settings = json.loads(config.read_text()) if config.exists() else {}
    if not isinstance(settings, dict):
        raise ValueError("Shared-browser configuration must be a JSON object")
    selected = settings.get("chrome", "")
    if selected and product(selected) in allowed:
        return Path(selected)
    names = ("chromium", "chromium-browser") if arm else ("google-chrome", "google-chrome-stable")
    candidates = (["/snap/bin/chromium"] if arm else []) + [shutil.which(name) for name in names]
    for candidate in candidates:
        if candidate and product(candidate) in allowed:
            binary = Path(candidate)
            save_selection(home, binary)
            return binary
    binary = arm_installer() if arm else installer(home)
    save_selection(home, binary)
    return binary


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["resolve"]:
            raise ValueError("Use: chrome.py resolve")
        print(resolve())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit("Shared browser Chrome setup failed: " + str(error))
