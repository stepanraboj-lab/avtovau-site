"""Проверка данных, статических страниц и архива без сторонних зависимостей."""

from copy import deepcopy
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree as ET
from zipfile import ZipFile
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build import ROOT, NONPUBLIC_ARCHIVE_ENTRIES, build, days, rubles, validate


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
        self.links.extend(props[key] for key in ("href", "src", "data-thumbnail") if key in props)
        if "srcset" in props:
            assert props.get("sizes"), "Для srcset нужен sizes"
            self.links.extend(candidate.strip().split()[0] for candidate in props["srcset"].split(","))


data = json.loads((ROOT / "fleet.json").read_text(encoding="utf-8"))
source = (ROOT / "site.zip").read_bytes()
assert build(data, source) == source, "Архив не соответствует сборке"
base = f'https://{data["company"]["domain"]}'
routes = {"/", "/privacy.html", "/requisites.html", *(v["path"] for v in data["vehicles"])}
with ZipFile(ROOT / "site.zip") as archive:
    assert archive.testzip() is None
    names = set(archive.namelist())
    assert len(names) == len(archive.namelist())
    assert names.isdisjoint(NONPUBLIC_ARCHIVE_ENTRIES)
    assert {"404.html", "CNAME", ".nojekyll", "sitemap.xml", "robots.txt", "favicon.png"} <= names
    sitemap = ET.fromstring(archive.read("sitemap.xml"))
    locations = [loc.text for loc in sitemap.findall(".//{http://www.sitemaps.org/schemas/sitemap/0.9}loc")]
    assert set(locations) == {base + route for route in routes} and len(locations) == len(routes)
    assert base + "/sitemap.xml" in archive.read("robots.txt").decode()
    pages = {route: Page(archive.read(route.lstrip("/") + ("index.html" if route.endswith("/") else "")).decode()) for route in routes}
    pages["/404.html"] = Page(archive.read("404.html").decode())
    privacy_page = archive.read("privacy.html").decode()
    requisites_page = archive.read("requisites.html").decode()
    assert "Политика обработки персональных данных и конфиденциальности" in privacy_page
    assert len(re.findall(r"<section><h2>\d+\.", privacy_page)) == 15
    assert "Адрес выдачи автомобилей" in requisites_page
    organization = next(item for item in json.loads(re.search(
        r'type="application/ld\+json">(.*?)</script>', archive.read("index.html").decode()
    )[1])["@graph"] if item["@type"] == "Organization")
    assert organization["email"] == data["legal"]["email"]
    assert organization["location"]["@type"] == "Place"
    assert organization["location"]["address"]["streetAddress"] == data["company"]["pickup"]["street"]
    assert "address" not in organization
    assert f'mailto:{data["legal"]["email"]}' in privacy_page
    for route in routes:
        name = route.lstrip("/") + ("index.html" if route.endswith("/") else "")
        markup = archive.read(name).decode()
        config = json.loads(re.search(r'id="page-settings">(.*?)</script>', markup)[1])
        assert config["counterId"] == (data["analytics"]["counter_id"] if data["legal"]["policy_approved"] else None)
        assert 'id="analytics-settings"' in markup and "legal-footer" in markup
        assert "Снайперская" not in markup
        assert f'mailto:{data["legal"]["email"]}' in markup
    approved = {
        "peugeot-308-sw": (7, 15000, 150, 20),
        "vw-polo-2013": (1, 7000, 150, 15),
        "renault-logan": (1, 7000, 150, 15),
        "kia-rio": (1, 7000, 150, 15),
    }
    group_titles = [
        "Требования к водителю", "Страхование", "Пробег и территория", "Оплата и депозит",
        "Правила эксплуатации", "Действия при ДТП", "В каждой машине",
    ]
    total_tariffs = 0
    for vehicle in data["vehicles"]:
        total_tariffs += len(vehicle["tariffs"])
        minimum, deposit, km, overage = approved[vehicle["id"]]
        assert (vehicle["minimum_days"], vehicle["deposit"]["rub"], vehicle["daily_km"], vehicle["overage_rub"]) == (minimum, deposit, km, overage)
        content = archive.read(vehicle["path"].lstrip("/") + "index.html").decode()
        original = vehicle["photo"]["src"]
        expected = list(dict.fromkeys(image["src"] for image in vehicle["gallery"]))
        if original not in expected:
            expected.insert(0, original)
        featured = vehicle.get("catalog_image")
        if featured:
            source = featured["src"]
            expected = [source, *(path for path in expected if path != source)]
            assert f'class="hero-photo-link" data-photo-index="0" href="/{source}"' in content
            assert f'<div class="catalog-photo"><img class="" src="/{source}"' in archive.read("index.html").decode()
        gallery = content.split('id="photos"', 1)[1].split("</section>", 1)[0]
        assert re.findall(r'data-photo-index="\d+" href="/([^"]+)"', gallery) == expected
        terms = content.split('id="terms"', 1)[1].split("</section>", 1)[0]
        order = [terms.index(title) for title in group_titles]
        assert order == sorted(order)
        assert f"Перепробег — {overage} ₽/км." in terms and "Территория эксплуатации — до ЦКАД." in terms
        assert f'Возвратный депозит — {deposit:,}'.replace(",", " ") in terms
        table = content.split('id="tariffs"', 1)[1].split("</section>", 1)[0]
        rows = re.findall(r"<tr><td>([^<]+)</td><td>([^<]+)</td></tr>", table)
        ordered = sorted(vehicle["tariffs"], key=lambda rate: rate["days"])
        assert len(rows) == len(ordered)
        for index, (label, price) in enumerate(rows):
            rate = ordered[index]
            lower = rate["days"]
            if index == len(ordered) - 1:
                assert label == f"От {days(lower)}"
            else:
                upper = ordered[index + 1]["days"] - 1
                assert label == (days(lower) if lower == upper else f"{lower}–{days(upper)}")
            assert price == f'{rubles(rate["daily_rub"])} ₽'
    assert total_tariffs == 18
    excluded = ("внж", "рвп", "осагo без огранич", "осаго без огранич", "незамедлительно сообщ",
                "сразу связаться с владельцем", "25 ₽ за килом", "25 ₽/км")
    for entry in names:
        if entry.endswith((".html", ".txt")):
            content = archive.read(entry).decode().lower()
            assert all(text not in content for text in excluded), entry
            assert all(text not in content for text in ("снайперск", "банковская визитка", "i.tochka.com/bank/myprofile")), entry
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
