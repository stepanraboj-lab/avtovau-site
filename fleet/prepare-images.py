"""Создаёт WebP для адаптивной выдачи. Оригиналы в архиве сохраняются без изменений."""

from io import BytesIO
import json
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from PIL import Image, ImageOps

from build import ROOT, CATALOG_WIDTHS, GALLERY_WIDTHS, catalog_photo, responsive_path


def prepare(source, data):
    catalog = {catalog_photo(vehicle)["src"] for vehicle in data["vehicles"]}
    if data.get("home_banner"):
        catalog.add(data["home_banner"]["src"])
    else:
        catalog.add(data["home_photo"]["src"])
    gallery = {image["src"] for vehicle in data["vehicles"]
               for image in [vehicle["photo"], *vehicle["gallery"]]} | catalog
    result = BytesIO()
    with ZipFile(BytesIO(source)) as originals, ZipFile(result, "w", ZIP_DEFLATED, compresslevel=1) as output:
        output.comment = originals.comment
        for entry in originals.infolist():
            if not entry.filename.startswith("assets/responsive/"):
                output.writestr(entry, originals.read(entry))
        for path in sorted(gallery):
            with Image.open(BytesIO(originals.read(path))) as original:
                profile = original.info.get("icc_profile")
                image = ImageOps.exif_transpose(original).convert("RGB")
                widths = {224, *(CATALOG_WIDTHS if path in catalog else GALLERY_WIDTHS)}
                for width in sorted(widths):
                    if width >= image.width:
                        continue
                    height = round(image.height * width / image.width)
                    variant = image.resize((width, height), Image.Resampling.LANCZOS)
                    asset = BytesIO()
                    variant.save(asset, format="WEBP", quality=80, method=6, icc_profile=profile)
                    entry = ZipInfo(responsive_path(path, width), (1980, 1, 1, 0, 0, 0))
                    entry.compress_type = ZIP_DEFLATED
                    output.writestr(entry, asset.getvalue())
    return result.getvalue()


if __name__ == "__main__":
    archive = ROOT / "site.zip"
    config = json.loads((ROOT / "fleet.json").read_text(encoding="utf-8"))
    archive.write_bytes(prepare(archive.read_bytes(), config))
