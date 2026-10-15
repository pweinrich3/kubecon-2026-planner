# KubeCon NA 2026 Planner

Simple, mobile-first session browser and schedule builder for KubeCon + CloudNativeCon North America 2026 (Salt Lake City, Nov 8–12).

**Live:** https://pweinrich3.github.io/kubecon-2026-planner/

- Browse by day, search, filter by track, level and venue
- ☆ sessions to build your schedule; overlaps are flagged
- Export picks to calendar (.ics) or copy a link to move them to another device
- Picks are stored in your browser (localStorage)

## Data

`scraper/scrape.py` pulls the official schedule from
https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/
into `sessions.json`. The **Update schedule** GitHub Action runs it every 4 hours
(or on demand from the Actions tab) and commits only when the data changes.

Run locally:

```sh
pip install -r scraper/requirements.txt
python scraper/scrape.py
python -m http.server  # then open http://localhost:8000
```
