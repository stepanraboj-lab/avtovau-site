"""Проверка данных, статических страниц и архива без сторонних зависимостей."""

from copy import deepcopy
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import ZipFile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import ROOT, build, validate


class Page(HTMLParser):
    def __init__(self, markup):
        super().__init__()
        self.ids = set()
        self.links = []
        self.canonical = []
        self.feed(markup)

    def handle_starttag(self, tag, raw):
        props = dict(raw)
        if "id" in props:
            assert props["id"] not in self.ids, f'Повтор ID {props["id"]}'
            self.ids.add(props["id"])
        if tag == "link" and props.get("rel") == "canonical":
            self.canonical.append(props["href"])
        self.links.extend(props[key] for key in ("href", "src") if key in props)


data = json.loads((ROOT / "fleet.json").read_text(encoding="utf-8"))
source = (ROOT / "site.zip").read_bytes()
assert build(data, source) == source, "Архив не соответствует сборке"
base = f'https://{data["company"]["domain"]}'
routes = {"/", *(v["path"] for v in data["vehicles"])}
with ZipFile(ROOT / "site.zip") as archive:
    assert archive.testzip() is None
    names = set(archive.namelist())
    assert len(names) == len(archive.namelist())
    assert {"404.html", "CNAME", ".nojekyll", "sitemap.xml", "robots.txt", "favicon.png"} <= names
    sitemap = ET.fromstring(archive.read("sitemap.xml"))
    locations = [loc.text for loc in sitemap.findall(".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc")]
    assert set(locations) == {base + route for route in routes} and len(locations) == len(routes)
    assert base + "/sitemap.xml" in archive.read("robots.txt").decode()
    pages = {route: Page(archive.read(route.lstrip("/") + "index.html").decode()) for route in routes}
    pages["/404.html"] = Page(archive.read("404.html").decode())
    for route, page in pages.items():
        assert page.canonical == ([base + route] if route in routes else [])
        for link in page.links:
            target = urlsplit(link)
            if target.scheme or target.netloc:
                continue
            target_path = unquote(target.path) or route
            if target_path in pages:
                assert not target.fragment or target.fragment in pages[target_path].ids, (route, link)
            else:
                assert target_path.lstrip("/") in names, (route, link)
    for change in (
        lambda copy: copy["vehicles"].append(copy["vehicles"][0]),
        lambda copy: copy["vehicles"][0].update(status="rented", rented_until="2026-02-30"),
        lambda copy: copy["vehicles"][0]["tariffs"][0].update(daily_rub=0),
        lambda copy: copy["company"]["contacts"][0].update(url="http://t.me/example"),
        lambda copy: copy["vehicles"][0]["photo"].update(src="assets/missing.jpg"),
        lambda copy: copy["analytics"].update(counter_id=123, privacy_url=None),
    ):
        candidate = deepcopy(data)
        change(candidate)
        try:
            validate(candidate, archive)
        except ValueError:
            continue
        raise AssertionError("Некорректные данные прошли валидацию")
print("Проверены данные, отрицательные сценарии, ссылки, sitemap, canonical и ZIP.")
