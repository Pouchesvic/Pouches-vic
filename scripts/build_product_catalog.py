#!/usr/bin/env python3
"""Refresh the bundled product catalog from approved official brand sources.

This is a maintenance-time tool only. Production reads product-catalog.json and
the normalized local images; it never contacts the source sites to render cards.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from hashlib import sha256
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


ROOT = Path(__file__).resolve().parents[1]
IMAGE_DIR = ROOT / "public" / "product-images"
MANIFEST_PATH = ROOT / "product-catalog.json"
RETRIEVED = date(2026, 8, 18).isoformat()
USER_AGENT = "PouchesVic catalog maintenance/1.0"


def get_bytes(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=45) as response:
        return response.read()


def get_text(url: str) -> str:
    return get_bytes(url).decode("utf-8", errors="replace")


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def strength_number(value: str) -> str:
    value = re.sub(r"\s*mg\s*$", "", value.strip(), flags=re.I)
    try:
        number = float(value.replace(",", "."))
        return str(int(number)) if number.is_integer() else f"{number:g}"
    except ValueError:
        return value


def velo_products() -> list[dict]:
    feed = "https://www.velo.com/en-gb/collections/all/products.json?limit=250"
    products = json.loads(get_text(feed))["products"]
    rows: list[dict] = []
    for product in products:
        handle = product["handle"]
        if handle == "subscription-bundle":
            continue
        base_name = product["title"]
        limited = ""
        flavor = base_name
        if handle == "spicy-papaya":
            flavor = "Spicy Papaya"
            limited = "Circuit Collection"
        elif handle == "mango-ice-tomorrowland-2026":
            flavor = "Mango Ice"
            limited = "Tomorrowland Limited Edition 2026"
        elif flavor.endswith(" Nano"):
            flavor = flavor[:-5]
            limited = "Nano"
        for variant in product["variants"]:
            if "/" not in variant["title"] or "mg" not in variant["title"].lower():
                continue
            form, strength = (part.strip() for part in variant["title"].split("/", 1))
            strength = strength_number(strength)
            series_bits = ["UK", limited, form]
            series = " • ".join(bit for bit in series_bits if bit)
            key = f"velo-uk-{handle}-{variant['id']}"
            image = (variant.get("featured_image") or {}).get("src", "")
            rows.append({
                "catalog_key": key,
                "brand": "VELO",
                "flavor": flavor,
                "strength": strength,
                "series": series,
                "notes": f"Official VELO UK {form} pouch.",
                "source_market": "United Kingdom",
                "source_url": f"https://www.velo.com/en-gb/products/{handle}",
                "catalog_source": feed,
                "image_source": image,
                "local_image": f"/product-images/{key}.webp",
            })
    return rows


PABLO_CATEGORIES = {
    "pablo": "Original",
    "pablo-dry": "Dry",
    "pablo-exclusive": "Exclusive",
    "pablo-gold-edition": "Gold Edition",
    "pablo-mini": "Mini",
    "pablo-silver-edition": "Silver Edition",
}


def pablo_listing() -> list[dict]:
    base = "https://ngpeurope.eu"
    rows: dict[str, dict] = {}
    card_pattern = re.compile(
        r'<a href="(?P<href>/product/[^\"]+)" class="d-block">\s*'
        r'<img src="(?P<img>[^\"]+)" alt="(?P<name>[^\"]+)"',
        re.I,
    )
    for category, series in PABLO_CATEGORIES.items():
        for page in range(1, 5):
            listing_url = f"{base}/products/nicopods/{category}?pagination={page}"
            matches = list(card_pattern.finditer(get_text(listing_url)))
            for match in matches:
                href = match.group("href")
                product_id = href.split("/")[2]
                rows[href] = {
                    "product_id": product_id,
                    "name": match.group("name").strip(),
                    "series": series,
                    "source_url": urllib.parse.urljoin(base, href),
                    "catalog_source": f"{base}/products/nicopods/{category}",
                    "image_source": urllib.parse.urljoin(base, match.group("img")),
                }
            if len(matches) < 20:
                break
    return list(rows.values())


def pablo_detail(row: dict) -> dict:
    name = row["name"]
    series = row["series"]
    if series == "Exclusive":
        strength = "50"
        flavor = re.sub(r"^Pablo Exclusive 50mg\s+", "", name, flags=re.I)
    elif series == "Gold Edition":
        strength = "17"
        flavor = re.sub(r"^Pablo Gold Edition\s+", "", name, flags=re.I)
    elif series == "Silver Edition":
        strength = "10.2"
        flavor = re.sub(r"^Pablo Silver Edition\s+", "", name, flags=re.I)
    else:
        detail = get_text(row["source_url"])
        match = re.search(r"Nicotine per product.{0,5000}?(\d+(?:[.,]\d+)?)\s*mg", detail, re.I | re.S)
        strength = strength_number(match.group(1)) if match else ""
        flavor = re.sub(r"^Pablo\s+", "", name, flags=re.I)
    flavor = re.sub(r"\s+\d+(?:\.\d+)?\s*(?:g|gr)\s*$", "", flavor, flags=re.I).strip()
    key = f"pablo-eu-{row['product_id']}"
    return {
        "catalog_key": key,
        "brand": "Pablo",
        "flavor": flavor,
        "strength": strength,
        "series": f"Europe • {series}",
        "notes": f"Official N.G.P. Tobacco Pablo {series} catalog entry.",
        "source_market": "Europe",
        "source_url": row["source_url"],
        "catalog_source": row["catalog_source"],
        "image_source": row["image_source"],
        "local_image": f"/product-images/{key}.webp",
    }


def pablo_products() -> list[dict]:
    listing = pablo_listing()
    rows: list[dict] = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(pablo_detail, row): row for row in listing}
        for future in as_completed(futures):
            rows.append(future.result())
    return sorted(rows, key=lambda row: row["catalog_key"])


def white_fox_products() -> list[dict]:
    base = "https://cdn11.bigcommerce.com/s-60xka3cpcr/images/stencil/500x659/products"
    source = "https://gn-us.com/white-fox/"
    data = [
        ("mint", "Mint", "12", "Slims Portion", f"{base}/116/436/gn-tobacco-product-on-white-white-fox-mint-straight-on__42189.1731338080.jpg?c=1"),
        ("double-mint", "Double Mint", "12", "Slims Portion", f"{base}/117/434/gn-tobacco-product-on-white-white-fox-double-mint-straight-on__25542.1731338011.jpg?c=1"),
        ("peppered-mint", "Peppered Mint", "12", "Slims Portion", f"{base}/119/430/gn-tobacco-product-on-white-white-fox-peppered-mint-straight-on__12415.1731337833.jpg?c=1"),
        ("full-charge", "Full Charge", "18", "Regular Portion", f"{base}/118/432/gn-tobacco-product-on-white-white-fox-full-charge-straight-on__05408.1731337903.jpg?c=1"),
        ("black-edition", "Black Edition", "20", "Slims Portion", f"{base}/120/428/gn-tobacco-product-on-white-white-fox-black-edition-straight-on__24271.1731337768.jpg?c=1"),
    ]
    return [{
        "catalog_key": f"white-fox-us-{key}",
        "brand": "White Fox",
        "flavor": flavor,
        "strength": strength,
        "series": f"US • {portion}",
        "notes": f"Official GN Tobacco US {portion} catalog entry.",
        "source_market": "United States",
        "source_url": source,
        "catalog_source": source,
        "image_source": image,
        "local_image": f"/product-images/white-fox-us-{key}.webp",
    } for key, flavor, strength, portion, image in data]


def zyn_products() -> list[dict]:
    source = "https://us.zyn.com/all-products/"
    html = get_text(source)
    product_pattern = re.compile(
        r'<a href="(?P<href>/all-products/[^\"]+/)"[^>]*data-product-name="(?P<name>[^\"]+)"[^>]*>(?P<body>.*?)</a>',
        re.I | re.S,
    )
    rows: list[dict] = []
    for match in product_pattern.finditer(html):
        href = match.group("href")
        name = match.group("name").strip()
        images = re.findall(r'<img[^>]+src="(https://smpmi\.cdn-norce\.tech/[^\"]+)"', match.group("body"), re.I)
        if len(images) < 2:
            continue
        is_ultra = name.lower().startswith("zyn ultra ")
        flavor = re.sub(r"^ZYN Ultra\s+|^ZYN\s+", "", name, flags=re.I).strip()
        strengths = ("9", "11") if is_ultra else ("3", "6")
        series = "US • Ultra" if is_ultra else "US • Classic"
        handle = href.strip("/").split("/")[-1]
        for strength, image in zip(strengths, images[:2]):
            key = f"zyn-us-{handle}-{strength}mg"
            rows.append({
                "catalog_key": key,
                "brand": "ZYN",
                "flavor": flavor,
                "strength": strength,
                "series": series,
                "notes": f"Official ZYN USA {'Ultra hydro-boosted' if is_ultra else 'Classic'} nicotine pouch.",
                "source_market": "United States",
                "source_url": urllib.parse.urljoin(source, href),
                "catalog_source": source,
                "image_source": image,
                "local_image": f"/product-images/{key}.webp",
            })
    if len(rows) != 42:
        raise RuntimeError(f"Expected 42 official ZYN USA SKUs, found {len(rows)}")
    return rows


def content_bbox(image: Image.Image) -> tuple[int, int, int, int]:
    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    if alpha.getextrema()[0] < 250:
        bbox = alpha.point(lambda value: 255 if value > 8 else 0).getbbox()
        if bbox:
            return bbox
    rgb = rgba.convert("RGB")
    mask = Image.new("L", rgb.size)
    pixels = mask.load()
    source = rgb.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            r, g, b = source[x, y]
            pixels[x, y] = 255 if min(r, g, b) < 242 or max(r, g, b) - min(r, g, b) > 12 else 0
    return mask.getbbox() or (0, 0, image.width, image.height)


def normalize_image(source: bytes, destination: Path) -> tuple[int, int, str]:
    with Image.open(io.BytesIO(source)) as opened:
        fmt = (opened.format or "").upper()
        if fmt not in {"PNG", "JPEG", "WEBP"}:
            raise ValueError(f"unsupported image format {fmt or 'unknown'}")
        opened.load()
        image = opened.convert("RGBA")
    # Source marketing images can be several thousand pixels wide. Downsample
    # before foreground detection so the one-time catalog build stays quick.
    image.thumbnail((900, 900), Image.Resampling.LANCZOS)
    left, top, right, bottom = content_bbox(image)
    pad_x = max(4, int((right - left) * 0.04))
    pad_y = max(4, int((bottom - top) * 0.04))
    crop = image.crop((max(0, left-pad_x), max(0, top-pad_y), min(image.width, right+pad_x), min(image.height, bottom+pad_y)))
    fitted = ImageOps.contain(crop, (420, 420), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (480, 480), (255, 255, 255, 0))
    canvas.alpha_composite(fitted, ((480-fitted.width)//2, (480-fitted.height)//2))
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination, "WEBP", quality=88, method=6)
    with Image.open(destination) as verified:
        verified.verify()
    return 480, 480, fmt


def placeholder() -> Path:
    target = IMAGE_DIR / "catalog-placeholder.webp"
    canvas = Image.new("RGB", (480, 480), "#f1f1ed")
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle((90, 115, 390, 365), radius=45, fill="#ffffff", outline="#111111", width=8)
    draw.ellipse((130, 70, 350, 210), fill="#ffffff", outline="#111111", width=8)
    draw.text((155, 240), "IMAGE", fill="#111111", font=ImageFont.load_default(size=28))
    draw.text((132, 282), "COMING SOON", fill="#555555", font=ImageFont.load_default(size=20))
    canvas.save(target, "WEBP", quality=85, method=6)
    return target


def build() -> None:
    rows = velo_products() + pablo_products() + white_fox_products() + zyn_products()
    rows.sort(key=lambda row: (row["brand"].lower(), row["series"].lower(), row["flavor"].lower(), float(row["strength"] or 0), row["catalog_key"]))
    previous: dict[str, dict] = {}
    if MANIFEST_PATH.exists():
        previous = {row["catalog_key"]: row for row in json.loads(MANIFEST_PATH.read_text(encoding="utf-8")).get("products", [])}
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    placeholder()
    cache: dict[str, bytes] = {}
    failures: list[dict] = []
    for index, row in enumerate(rows, 1):
        target = ROOT / "public" / row["local_image"].lstrip("/")
        try:
            if target.exists():
                with Image.open(target) as existing:
                    if existing.format != "WEBP" or existing.size != (480, 480):
                        raise ValueError("cached normalized image failed format or dimension validation")
                    existing.verify()
                width, height = 480, 480
                source_format = previous.get(row["catalog_key"], {}).get("source_image_format", "WEBP")
            else:
                source = cache.setdefault(row["image_source"], get_bytes(row["image_source"]))
                width, height, source_format = normalize_image(source, target)
            row["image_verified"] = True
            row["image_width"] = width
            row["image_height"] = height
            row["source_image_format"] = source_format
            row["image_sha256"] = sha256(target.read_bytes()).hexdigest()
        except Exception as exc:  # keep the SKU, but never guess its artwork
            row["image_verified"] = False
            row["image_error"] = str(exc)
            row["local_image"] = "/product-images/catalog-placeholder.webp"
            failures.append({"catalog_key": row["catalog_key"], "error": str(exc)})
        if index % 20 == 0:
            print(f"processed {index}/{len(rows)} images", file=sys.stderr)
    manifest = {
        "schema_version": 1,
        "catalog_version_date": RETRIEVED,
        "runtime_external_requests_required": False,
        "approved_sources": [
            "https://www.velo.com/en-gb/collections/all",
            "https://ngpeurope.eu/products/nicopods/",
            "https://gn-us.com/white-fox/",
            "https://us.zyn.com/all-products/",
        ],
        "counts": {
            "VELO": sum(row["brand"] == "VELO" for row in rows),
            "Pablo": sum(row["brand"] == "Pablo" for row in rows),
            "White Fox": sum(row["brand"] == "White Fox" for row in rows),
            "ZYN": sum(row["brand"] == "ZYN" for row in rows),
            "total": len(rows),
            "verified_images": sum(bool(row["image_verified"]) for row in rows),
        },
        "image_failures": failures,
        "products": rows,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest["counts"], indent=2))
    if failures:
        print(json.dumps(failures, indent=2), file=sys.stderr)


if __name__ == "__main__":
    build()
