"""Content Rewards in the owner's own logged-in Chrome (same setup as wn-watcher: real Chrome, own profile, CDP).

No --enable-automation flag, so the site sees a normal browser. The profile lives on E: and holds only the CR login.
Usage: cr_browser.py open [url]        start Chrome (if needed) and open a page, e.g. to log in once
       cr_browser.py dump <url>        JSON: page text, links, JSON API calls seen while loading
       cr_browser.py discover          JSON: campaigns the Discover page loads
       cr_browser.py join <url>        join a campaign, JSON: page text with the brief
       cr_browser.py click <url> <label> [shot]  click a button/tab, JSON: text and buttons after
Output is one JSON object on stdout.
"""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / "data" / "cr-chrome"
PORT = 9333  # wn-watcher uses 9222: never share its browser
CHROME = [Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
          Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe"]
HOME = "https://contentrewards.com/c/campaigns"


def port_open() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def ensure_chrome(url: str = "about:blank") -> None:
    if port_open():
        return
    exe = next((p for p in CHROME if p.is_file()), None)
    if not exe:
        raise SystemExit(json.dumps({"error": "Chrome not found"}))
    PROFILE.mkdir(parents=True, exist_ok=True)
    subprocess.Popen([str(exe), f"--remote-debugging-port={PORT}", f"--user-data-dir={PROFILE}",
                      "--no-first-run", "--no-default-browser-check", "--mute-audio", url],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if port_open():
            return
        time.sleep(0.5)
    raise SystemExit(json.dumps({"error": "Chrome debug port did not open"}))


def with_page(fn):
    from playwright.sync_api import sync_playwright
    ensure_chrome()
    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}")
        ctx = browser.contexts[0]
        page = ctx.new_page()
        try:
            return fn(page)
        finally:
            page.close()  # only our own tab; Chrome and the login stay


def dump(url: str) -> dict:
    def go(page):
        calls, seen = [], []
        page.on("response", lambda r: seen.append(r) if "json" in (r.headers.get("content-type") or "") else None)
        page.goto(url, wait_until="networkidle", timeout=60_000)
        for r in seen:
            try:
                body = r.json() if "/api/" in r.url else None
            except Exception:
                body = None
            calls.append({"url": r.url.split("?")[0], "method": r.request.method, "status": r.status, "body": body})
        links = page.eval_on_selector_all("a[href]", "as => as.map(a => ({text: a.innerText.trim().slice(0, 80), href: a.href}))")
        return {"url": page.url, "title": page.title(), "text": page.inner_text("body")[:20000], "links": links, "json": calls}
    return with_page(go)


def click(url: str, label: str, shot: str = "") -> dict:
    """Opens url, clicks the first button named label, returns what changed: API writes and the visible text after."""
    def go(page):
        writes = []
        page.on("response", lambda r: writes.append({"url": r.url.split("?")[0], "method": r.request.method, "status": r.status,
                                                     "req": r.request.post_data})
                if r.request.method != "GET" and "/api/" in r.url else None)
        page.goto(url, wait_until="networkidle", timeout=60_000)
        for role in ("button", "tab", "link", "menuitem"):
            el = page.get_by_role(role, name=label, exact=True)
            if el.count():
                el.first.click(timeout=15_000)
                break
        else:
            page.get_by_text(label, exact=True).first.click(timeout=15_000)
        page.wait_for_timeout(4000)
        if shot:
            page.screenshot(path=shot)
        buttons = [b.inner_text().strip() for b in page.get_by_role("button").all() if b.is_visible()]
        return {"url": page.url, "text": page.inner_text("body")[:8000], "buttons": [b for b in buttons if b], "writes": writes}
    return with_page(go)


def discover() -> dict:
    """All campaigns the Discover page loads, from CR's own JSON responses (the site's fetches; ours get 'Failed to fetch').
    shortcut: only what the page loads on open (~100 campaigns, no scrolling for more pages), fine while that covers the GTA/streamer rows."""
    def go(page):
        seen = []
        page.on("response", lambda r: seen.append(r) if "/api/campaign/campaigns/discover" in r.url else None)
        page.goto("https://contentrewards.com/c/discover", wait_until="networkidle", timeout=60_000)
        out = {}
        for r in seen:
            try:
                data = r.json().get("data")
            except Exception:
                continue
            rows = data if isinstance(data, list) else (data or {}).get("campaigns") if isinstance(data, dict) else None
            for c in rows or []:
                if isinstance(c, dict) and c.get("id") and c.get("name"):
                    out[c["id"]] = c
        return {"campaigns": list(out.values())}
    return with_page(go)


def join(url: str) -> dict:
    """Joins a campaign (owner allowed this) and returns the page text, which shows the brief only after joining."""
    def go(page):
        page.goto(url, wait_until="networkidle", timeout=60_000)
        if "Joined" not in page.inner_text("body"):
            page.get_by_role("button", name="Join Campaign").first.click(timeout=15_000)
            page.wait_for_timeout(4000)
            page.reload(wait_until="networkidle", timeout=60_000)
        text = page.inner_text("body")
        return {"joined": "Joined" in text, "text": text[:20000]}
    return with_page(go)


if __name__ == "__main__":
    cmd, arg = (sys.argv[1:] + ["", ""])[:2]
    if cmd == "open":
        if port_open():
            from playwright.sync_api import sync_playwright
            with sync_playwright() as pw:
                pw.chromium.connect_over_cdp(f"http://127.0.0.1:{PORT}").contexts[0].new_page().goto(arg or HOME)
        else:
            ensure_chrome(arg or HOME)
        print(json.dumps({"ok": True}))
    elif cmd == "dump":
        print(json.dumps(dump(arg or HOME)))
    elif cmd == "discover":
        print(json.dumps(discover()))
    elif cmd == "join":
        print(json.dumps(join(arg)))
    elif cmd == "click":
        print(json.dumps(click(arg, sys.argv[3], (sys.argv[4:] or [""])[0])))
    else:
        raise SystemExit(__doc__)
