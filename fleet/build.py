"""Собирает статический сайт из fleet.json, шаблонов и исходных ресурсов site.zip."""

import argparse
from datetime import date
from html import escape
from io import BytesIO
import json
from pathlib import Path
import re
from string import Template
from urllib.parse import urlsplit
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = Path(__file__).with_name("templates")
EQUIPMENT = {
    "air_conditioning": "Кондиционер",
    "climate_control": "Климат-контроль",
    "bluetooth": "Bluetooth",
    "cruise_control": "Круиз-контроль",
    "subwoofer": "Сабвуфер",
    "amplifier": "Усилитель аудиосистемы",
    "door_soundproofing": "Шумоизоляция дверей",
    "rear_camera": "Камера заднего вида",
    "dashcam": "Видеорегистратор",
    "parking_sensors": "Парктроники",
    "upgraded_audio": "Улучшенная аудиосистема",
    "spacious_trunk": "Просторный багажник",
}
ICONS = {
    "year": "M3 5h18v16H3zM7 3v4m10-4v4M3 10h18",
    "body": "M3 16v-4l2-2 2-4h10l2 4 2 2v4H3zm3 0v2m12-2v2M7 12h.01M17 12h.01",
    "gear": "M6 5v14m6-14v14m6-14v7H6",
    "climate": "M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 5l3 3 3-3m-6 14 3-3 3 3",
    "bluetooth": "M12 2v20l6-5-12-10m6-5 6 5L6 17",
    "kit": "M3 7h18v13H3zM8 7V4h8v3m-4 3v7m-3-3.5h6",
    "charge": "M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4m0-4a6 6 0 0 1-6-6z",
    "holder": "M8 3h8v14H8zM5 10v9h14v-9m-7 9v2m-4 0h8",
    "arrow": "M5 19 19 5M9 5h10v10",
}


def render(template, **values):
    return Template((TEMPLATES / f"{template}.html").read_text(encoding="utf-8")).substitute(values)


def icon(name, css="feature-icon"):
    return (
        f'<svg class="{css}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" '
        f'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" '
        f'stroke-linejoin="round"><path d="{ICONS[name]}"/></svg>'
    )


def rubles(number):
    return f"{number:,}".replace(",", " ")


def days(number):
    unit = "дней"
    if not 11 <= number % 100 <= 14:
        if number % 10 == 1:
            unit = "день"
        elif number % 10 in (2, 3, 4):
            unit = "дня"
    return f"{number} {unit}"


def monthly(vehicle):
    return next(rate["daily_rub"] for rate in vehicle["tariffs"] if rate["days"] == 30)


def photo(image, css="", lazy=False, priority=False):
    loading = ' loading="lazy"' if lazy else ""
    fetch = ' fetchpriority="high"' if priority else ""
    return f'<img class="{css}" src="/{escape(image["src"])}" alt="{escape(image["alt"])}"{loading}{fetch}>'


def catalog_photo(vehicle):
    return vehicle.get("catalog_image", vehicle["photo"])


def gallery_link(image, index, hero=False):
    css = ' class="hero-photo-link"' if hero else ""
    return (
        f'<a{css} data-photo-index="{index}" href="/{escape(image["src"])}" '
        f'target="_blank" rel="noopener">{photo(image, "hero-photo" if hero else "", lazy=not hero)}</a>'
    )


def status(vehicle):
    kind = vehicle["status"]
    if kind == "rented":
        until = date.fromisoformat(vehicle["rented_until"])
        label = f'<time datetime="{until.isoformat()}">В аренде до {until:%d.%m.%Y}</time>'
    else:
        label = {"available": "Доступен", "unavailable": "Временно недоступен"}[kind]
    return f'<span class="availability availability--{kind}">{label}</span>'


def chips(items):
    return '<ul class="features">' + "".join(
        f"<li>{icon(symbol)}{escape(label)}</li>" for symbol, label in items
    ) + "</ul>"


def features(vehicle):
    items = vehicle["equipment"]
    climate = "Климат-контроль" if items["climate_control"] else {
        True: "Кондиционер", False: "Без кондиционера", None: "Кондиционер не указан"
    }[items["air_conditioning"]]
    bluetooth = {True: "Bluetooth", False: "Без Bluetooth", None: "Bluetooth не указан"}
    return chips([
        ("year", f'{vehicle["year"]} год'),
        ("body", vehicle["body"].capitalize()),
        ("gear", f'{vehicle["transmission"].capitalize()} КПП'),
        ("climate", climate),
        ("bluetooth", bluetooth[items["bluetooth"]]),
    ])


def inherited_equipment(data):
    return '<div class="common-equipment"><h2 id="common-title">В каждой машине</h2>' + chips(
        [(item["icon"], item["label"]) for item in data["common_equipment"]]
    ) + "</div>"


def contacts(company, variant):
    items = []
    for link in company["contacts"]:
        svg = (TEMPLATES / f'{link["id"]}.svg').read_text(encoding="utf-8").strip()
        external = ' target="_blank" rel="noopener"' if link["url"].startswith("https:") else ""
        items.append(
            f'<li><a class="contact-options__link" data-contact="{link["id"]}" href="{escape(link["url"])}" '
            f'aria-label="{escape(link["accessible_label"])}"{external}>'
            f'<span class="contact-options__icon">{svg}</span><span>{escape(link["label"])}</span></a></li>'
        )
    phone = next(link["url"] for link in company["contacts"] if link["id"] == "phone")
    return (
        f'<div class="contact-options contact-options--{variant}">'
        '<strong class="contact-options__title">Бронирование и вопросы</strong>'
        '<ul class="contact-options__list">' + "".join(items) + "</ul>"
        f'<a class="contact-options__number" data-contact="phone" href="{escape(phone)}">{escape(company["phone_display"])}</a></div>'
    )


def metadata(company, vehicle, hero):
    base = f'https://{company["domain"]}'
    url = base + (vehicle["path"] if vehicle else "/")
    image = f'{base}/{hero["src"]}'
    brand = company["name"]
    if vehicle:
        name, year = vehicle["name"], vehicle["year"]
        location = vehicle.get("rental_location")
        place = f" {location}" if location else ""
        title = f"Аренда {name} {year}{place} — {brand}"
        description = f'Аренда {name} {year}{place}. {vehicle["short_description"]} Фотографии, тарифы и условия аренды.'
        graph = [
            {"@type": "BreadcrumbList", "itemListElement": [
                {"@type": "ListItem", "position": 1, "name": brand, "item": base + "/"},
                {"@type": "ListItem", "position": 2, "name": name, "item": url},
            ]},
            {"@type": "Vehicle", "@id": url + "#vehicle", "url": url, "name": name,
             "brand": {"@type": "Brand", "name": vehicle["brand"]}, "model": vehicle["model"],
             "image": image, "description": description, "vehicleModelDate": str(year),
             "bodyType": vehicle["body"], "vehicleTransmission": vehicle["transmission"],
             "additionalProperty": [
                {"@type": "PropertyValue", "name": label, "value": vehicle["equipment"][key]}
                for key, label in EQUIPMENT.items() if vehicle["equipment"][key] is not None
             ]},
        ]
    else:
        title = f"{brand} — аренда автомобилей в Москве"
        description = f"{brand} (AutoVau) — каталог автомобилей в аренду в Москве. Фотографии, тарифы, условия аренды и бронирование."
        organization_id = base + "/#organization"
        graph = [
            {"@type": "Organization", "@id": organization_id, "url": url, "name": brand,
             "alternateName": company["alternate_names"]},
            {"@type": "WebSite", "@id": base + "/#website", "url": url, "name": brand,
             "alternateName": company["website_aliases"], "inLanguage": "ru",
             "publisher": {"@id": organization_id}},
        ]
    graph_json = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace("<", "\\u003c")
    og = {"type": "website", "site_name": brand, "locale": "ru_RU", "title": title,
          "description": description, "url": url, "image": image, "image:type": "image/jpeg", "image:alt": hero["alt"]}
    return "\n  ".join([
        f"<title>{escape(title)}</title>",
        f'<meta name="description" content="{escape(description)}">',
        f'<link rel="canonical" href="{escape(url)}">',
        *(f'<meta property="og:{key}" content="{escape(value)}">' for key, value in og.items()),
        f'<script type="application/ld+json">{graph_json}</script>',
    ])


def vehicle_page(vehicle, data):
    company = data["company"]
    equipment = []
    for key, label in EQUIPMENT.items():
        if vehicle["equipment"][key] is True:
            item = escape(label)
            note = vehicle.get("equipment_notes", {}).get(key)
            equipment.append(f"<li>{item}{' · ' + escape(note) if note else ''}</li>")
    terms = []
    for group in vehicle["terms"]:
        rules = "".join(f"<li>{escape(rule)}</li>" for rule in group["rules"])
        terms.append(f'<article><h3>{escape(group["title"])}</h3><ul>{rules}</ul></article>')
    tariffs = []
    for rate in vehicle["tariffs"]:
        note = f'<small>{escape(rate["note"])}</small>' if "note" in rate else ""
        total = rate["total_format"].format(total=rubles(rate["daily_rub"] * rate["days"]))
        tariffs.append(
            f'<tr><td>{escape(rate["label"])}{note}</td><td>{rubles(rate["daily_rub"])} ₽</td>'
            f'<td>{escape(total)}</td></tr>'
        )
    hero = vehicle["photo"]
    photos = list({image["src"]: image for image in vehicle["gallery"]}.values())
    if not any(image["src"] == hero["src"] for image in photos):
        photos.insert(0, hero)
    hero_index = next(i for i, image in enumerate(photos) if image["src"] == hero["src"])
    gallery = "".join(gallery_link(image, i) for i, image in enumerate(photos))
    return render(
        "vehicle", name=escape(vehicle["name"]), status=status(vehicle), features=features(vehicle),
        short_description=escape(vehicle["short_description"]), description=escape(vehicle["description"]),
        equipment='<ul class="equipment-list">' + "".join(equipment) + "</ul>" if equipment else "",
        hero_photo=gallery_link(hero, hero_index, hero=True), minimum=days(vehicle["minimum_days"]),
        daily_km=vehicle["daily_km"], deposit_label=escape(vehicle["deposit"]["label"]),
        deposit=rubles(vehicle["deposit"]["rub"]),
        deposit_note=paragraph(vehicle["deposit"].get("note")), terms="".join(terms),
        common_equipment=inherited_equipment(data), tariff_note=escape(vehicle["tariff_note"]),
        rental_notice=paragraph(vehicle.get("rental_notice")), tariffs="".join(tariffs), gallery=gallery,
        contact_note=escape(vehicle["contact_note"]), contacts=contacts(company, "booking"),
    )


def paragraph(value):
    return f'<p class="rental-notice">{escape(value)}</p>' if value else ""


def faq(vehicles):
    minimum = "; ".join(f'{v["name"]} — {days(v["minimum_days"])}' for v in vehicles)
    deposits = "; ".join(f'{v["name"]} — {rubles(v["deposit"]["rub"])} ₽' for v in vehicles)
    mileage = "; ".join(f'{v["name"]} — {v["daily_km"]} км' for v in vehicles)
    items = [
        ("Какие требования к водителю?", "Возраст от 21 года, безаварийный стаж от 3 лет. Документы и дополнительные требования зависят от автомобиля."),
        ("Какой минимальный срок аренды?", minimum + "."),
        ("Какой залог?", deposits + ". Условия возврата смотрите в карточке выбранной машины."),
        ("Какой пробег включён в сутки?", mileage + ". Размер доплаты указан в условиях конкретного автомобиля."),
        ("Можно ли запросить даты для занятой машины?", "Да, напишите владельцу о будущих датах. Доступность и стоимость подтверждает владелец."),
    ]
    return '<section class="wrap section faq" id="faq"><h2>Частые вопросы</h2>' + "".join(
        f'<details><summary>{escape(question)}</summary><p>{escape(answer)}</p></details>'
        for question, answer in items
    ) + "</section>"


def pages(data):
    company = data["company"]
    vehicles = data["vehicles"]
    hero = data["home_photo"]
    analytics = data.get("analytics", {})
    counter = analytics.get("counter_id")
    privacy_url = analytics.get("privacy_url")
    banner = data.get("home_banner")
    cards = "".join(render(
        "card", path=escape(v["path"]), photo=photo(catalog_photo(v), lazy=True), status=status(v),
        name=escape(v["name"]), features=features(v), monthly=rubles(monthly(v)).replace(" ", "&nbsp;"),
        arrow=icon("arrow", "details-arrow"),
    ) for v in vehicles)
    hero_image = photo(banner or hero, "hero-photo hero-banner" if banner else "hero-photo", priority=True)
    home = render("home", hero_image=hero_image, cards=cards, faq=faq(vehicles),
                  common_equipment=inherited_equipment(data), contacts=contacts(company, "booking"))

    def document(body, vehicle=None, missing=False):
        v = vehicle
        page_settings = {"counterId": counter, "vehicle": None}
        if v:
            page_settings["vehicle"] = {key: v[key] for key in ("id", "name", "year")}
            page_settings["vehicle"]["tariffs"] = [
                {key: rate[key] for key in ("days", "daily_rub")} for rate in v["tariffs"]
            ]
        return render(
            "page", body=body, brand=escape(company["name"]),
            page_class="vehicle-page" if v else "home-page", footer_contacts=contacts(company, "footer"),
            metadata=('<title>Страница не найдена — АвтоВау</title>'
                      '<meta name="description" content="Вернитесь на главную АвтоВау или откройте каталог автомобилей.">'
                      '<meta name="robots" content="noindex">') if missing
            else metadata(company, v, v["photo"] if v else hero),
            dialog_title=f'Связаться с {escape(company["name"])}',
            dialog_model=f'<p id="booking-model" class="booking-dialog__model" hidden>{escape(v["name"])}</p>' if v else "",
            dialog_label="booking-title", booking_dates=render("booking-dates", status=status(v)) if v else "",
            viewport_fit=",viewport-fit=cover" if v else "",
            photo_viewer=render("photo-viewer", model=escape(v["name"])) if v else "",
            photo_assets=(
                '<link rel="stylesheet" href="/assets/photo-viewer.css">\n  '
                '<script src="/assets/photo-viewer.js" defer></script>\n  '
            ) if v else "",
            analytics_settings='<button type="button" class="header-contact" id="analytics-settings">Настройки аналитики</button>' if counter else "",
            analytics_dialog=render("analytics-consent", privacy_url=escape(privacy_url)) if counter else "",
            page_settings=json.dumps(page_settings, ensure_ascii=False).replace("<", "\\u003c"),
        ).encode()

    output = {"index.html": document(home)}
    for v in vehicles:
        output[v["path"].lstrip("/") + "index.html"] = document(vehicle_page(v, data), v)
    sitemap = ET.Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for page in output:
        loc = f'https://{company["domain"]}/' + page.removesuffix("index.html")
        ET.SubElement(ET.SubElement(sitemap, "url"), "loc").text = loc
    ET.indent(sitemap, space="  ")
    output["sitemap.xml"] = ET.tostring(sitemap, encoding="utf-8", xml_declaration=True) + b"\n"
    output["404.html"] = document(render("404"), missing=True)
    assets = Path(__file__).with_name("assets")
    for name in ("fleet.css", "photo-viewer.css", "photo-viewer.js", "commercial.js", "booking-rules.js"):
        output[f"assets/{name}"] = (assets / name).read_bytes()
    return output


def validate(data, archive):
    analytics = data.get("analytics", {})
    counter = analytics.get("counter_id")
    privacy = analytics.get("privacy_url")
    if counter is not None and (type(counter) is not int or counter <= 0 or not privacy):
        raise ValueError("Для Метрики нужны целочисленный ID и адрес утверждённой политики")
    if privacy and not (
        (privacy.startswith("/") and not privacy.startswith("//") and "\\" not in privacy)
        or (urlsplit(privacy).scheme == "https" and urlsplit(privacy).hostname)
    ):
        raise ValueError("Для политики нужен HTTPS-адрес или локальный путь")
    contacts = data["company"]["contacts"]
    allowed_hosts = {"telegram": "t.me", "whatsapp": "wa.me", "avito": "www.avito.ru"}
    if sorted(contact["id"] for contact in contacts) != sorted([*allowed_hosts, "phone"]):
        raise ValueError("Укажите ровно по одной ссылке для Telegram, WhatsApp, Авито и телефона")
    for contact in contacts:
        kind, url = contact["id"], contact["url"]
        if kind == "phone":
            valid = re.fullmatch(r"tel:\+\d{7,15}", url)
        else:
            parsed = urlsplit(url)
            valid = parsed.scheme == "https" and parsed.netloc == allowed_hosts[kind] and len(parsed.path) > 1
        if not valid:
            raise ValueError(f"Некорректная ссылка контакта: {kind}")
    vehicles = data["vehicles"]
    ids = set()
    for v in vehicles:
        slug = v["id"]
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug) or slug in ids or v["path"] != f"/cars/{slug}/":
            raise ValueError(f"Некорректный или повторяющийся ID/адрес: {slug}")
        ids.add(slug)
        if set(v["equipment"]) != set(EQUIPMENT) or any(
            item is not None and type(item) is not bool for item in v["equipment"].values()
        ):
            raise ValueError(f"{slug}: комплектация должна содержать true, false или null")
        if v["status"] not in {"available", "rented", "unavailable"}:
            raise ValueError(f"{slug}: неизвестный статус")
        until = v["rented_until"]
        if (v["status"] == "rented") != bool(until) or (until and date.fromisoformat(until).isoformat() != until):
            raise ValueError(f"{slug}: неверная дата окончания аренды")
        periods = [r["days"] for r in v["tariffs"]]
        if (not periods or any(type(p) is not int or p <= 0 for p in periods)
                or min(periods) != v["minimum_days"] or 30 not in periods or len(set(periods)) != len(periods)):
            raise ValueError(f"{slug}: проверьте периоды тарифов и минимальный срок")
        if any(type(r["daily_rub"]) is not int or r["daily_rub"] <= 0 or "{total}" not in r["total_format"] for r in v["tariffs"]):
            raise ValueError(f"{slug}: стоимость должна быть целым положительным числом, а итог — содержать {{total}}")
    images = [data["home_photo"], *(image for v in vehicles for image in [v["photo"], catalog_photo(v), *v["gallery"]])]
    if "home_banner" in data:
        images.append(data["home_banner"])
    for image in images:
        if not image["src"].startswith("assets/") or image["src"] not in archive.namelist() or not image["alt"].strip():
            raise ValueError(f'Проверьте фото и его alt: {image["src"]}')
    if archive.read("CNAME").decode().strip() != data["company"]["domain"]:
        raise ValueError("Домен fleet.json должен совпадать с CNAME")


def build(data, source):
    buffer = BytesIO()
    with ZipFile(BytesIO(source)) as archive, ZipFile(buffer, "w", ZIP_DEFLATED) as output:
        validate(data, archive)
        generated = pages(data)
        output.comment = archive.comment

        def write(name):
            entry = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            output.writestr(entry, generated.pop(name))

        for entry in archive.infolist():
            if entry.filename in generated:
                write(entry.filename)
            elif not re.fullmatch(r"cars/[^/]+/index\.html", entry.filename):
                output.writestr(entry, archive.read(entry))
        for name in list(generated):
            write(name)
    return buffer.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "fleet.json")
    parser.add_argument("--archive", type=Path, default=ROOT / "site.zip")
    parser.add_argument("--check", action="store_true", help="Проверить актуальность архива без записи")
    args = parser.parse_args()
    data = json.loads(args.data.read_text(encoding="utf-8"))
    source = args.archive.read_bytes()
    result = build(data, source)
    if args.check:
        if result != source:
            raise SystemExit("site.zip устарел. Запустите python3 fleet/build.py")
        print("site.zip соответствует fleet.json и шаблонам")
    elif result != source:
        args.archive.write_bytes(result)
        print(f"Обновлён {args.archive}")


if __name__ == "__main__":
    main()
