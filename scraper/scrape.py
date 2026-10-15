"""Scrape the KubeCon NA 2026 schedule from the LF events site into sessions.json.

Usage: python scraper/scrape.py [--html saved_page.html] [--out sessions.json]
"""
import argparse
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone

from bs4 import BeautifulSoup

URL = "https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/"
LEVELS = {"Beginner", "Intermediate", "Advanced", "Any Level"}
MIN_SESSIONS = 100  # guard: refuse to overwrite good data with a broken scrape


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (kubecon-2026-planner scraper)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def text(el):
    return " ".join(el.get_text(" ", strip=True).split()) if el else ""


def clean_desc(el):
    """Description as a list of plain-text paragraphs."""
    if not el:
        return []
    for cf in el.select(".__cf_email__"):  # Cloudflare-obfuscated emails
        cf.replace_with("(email on official site)")
    for br in el.find_all("br"):
        br.replace_with("\n")
    paras = el.find_all("p") or [el]
    out = []
    for p in paras:
        t = "\n".join(" ".join(line.split()) for line in p.get_text().split("\n"))
        t = t.strip()
        if t:
            out.append(t)
    return out


def parse(html):
    soup = BeautifulSoup(html, "html.parser")
    sessions = {}
    for wrap in soup.select(".sess-wrap"):
        link = wrap.select_one("a.sess-link")
        if not link or not link.get("data-session-id"):
            continue
        sid = link["data-session-id"]
        times = wrap.select(".sess__seotime time")
        if len(times) < 1:
            continue
        start = times[0].get("datetime")
        end = times[1].get("datetime") if len(times) > 1 else start
        primary = wrap.select_one(".tag--primary")
        other = [text(t) for t in wrap.select(".sess__tags .tag:not(.tag--primary)")]
        speakers = [s.strip() for s in text(wrap.select_one(".sess__speakers")).split(",") if s.strip()]
        links = [
            {"label": text(a), "url": a.get("href")}
            for a in wrap.select(".sess__seolinks a")
            if a.get("href", "").startswith("http")
        ]
        sessions[sid] = {
            "id": sid,
            "title": text(wrap.select_one(".sess__title")),
            "start": start,
            "end": end,
            "room": text(wrap.select_one(".sess__room")),
            "speakers": speakers,
            "track": text(primary),
            "level": next((t for t in other if t in LEVELS), ""),
            "tags": [t for t in other if t not in LEVELS],
            "description": clean_desc(wrap.select_one(".sess__seodesc")),
            "links": links,
            "url": link.get("href"),
        }
    return sorted(sessions.values(), key=lambda s: (s["start"], s["end"], s["title"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", help="parse a saved HTML file instead of fetching")
    ap.add_argument("--out", default="sessions.json")
    args = ap.parse_args()

    html = open(args.html, encoding="utf-8").read() if args.html else fetch(URL)
    sessions = parse(html)
    if len(sessions) < MIN_SESSIONS:
        sys.exit(f"Only found {len(sessions)} sessions; page layout may have changed. Not writing.")

    # Keep the timestamp stable when nothing changed, so the workflow doesn't commit noise.
    try:
        old = json.load(open(args.out, encoding="utf-8"))
        if old.get("sessions") == sessions:
            print(f"No changes ({len(sessions)} sessions).")
            return
    except (OSError, ValueError):
        pass

    data = {
        "source": URL,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sessions": sessions,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"Wrote {len(sessions)} sessions to {args.out}.")


if __name__ == "__main__":
    main()
