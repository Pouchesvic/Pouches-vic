POUCHES VIC — FULL FOUNDATION BUILD v0.4

THIS BUILD IS A FOUNDATION, NOT JUST A MOCKUP.

WHAT IS BUILT

1) MULTI-TERRITORY
- Victoria, Kelowna and Prince George are preloaded.
- Add Territory from the phone admin.
- Each territory has isolated:
  - inventory/listing status
  - pricing tiers
  - delivery zones
  - drivers
  - orders
  - settlement rules
- A product catalog is shared, but stock/listed status is per territory.

2) PRODUCTS / INVENTORY
- Master catalog can hold 40, 50, 100+ products.
- Every territory decides:
  - stock count
  - listed / hidden
  - featured
  - optional local price override
- Hidden inventory stays in the system and can be put on the storefront with ADD TO STORE.
- Order submission reduces territory inventory automatically.
- Door swaps / returns / free cans can adjust inventory without rebuilding the order.

3) PRICING
Victoria is preloaded:
- 1–9 = $15.00/can
- 10–19 = $13.50/can
- 20+ = $12.50/can
Pricing is editable per territory from Admin.

4) VICTORIA DELIVERY ZONES
Green:
- $10
- free at 10+ cans
- Notes stored:
  south of Ash/Arbutus/Royal Oak
  south of Wilkinson
  south of Helmcken
  Downtown, Gordon Head, Oak Bay, Fairfield
  Pipeline Rd near View Royal exception
  near Victoria General: just south of the north-running boundary street

Orange:
- $15
- north of Royal Oak
- Pipeline to south of Keating
- north of Victoria General
- Bear Mountain, Colwood, Royal Bay
- south of Sooke Rd
- general Langford

Pink:
- $20
- north of Keating
- north of Sooke Rd beyond Royal Bay toward Happy Valley / Sooke
- north of where four lanes start
- regular max around Gillespie Rd or ~5 km up Happy Valley

IMPORTANT:
These are currently stored as plain-language territory rules, not fake automatic GPS geofences.
The customer selects the zone; Admin can change/remove the fee on any order.
The database is ready for real address-to-zone geocoding/polygons later.

5) DELIVERY FEE CONTROL
- Zone fee editable.
- Free-at-quantity editable.
- Zone can be disabled.
- On each order Boss/Operations Admin can lower, remove, or change the delivery fee and add an override note.

6) DRIVERS
Victoria preloaded:
- Victoria Driver 1 = Operations Admin
- Victoria Driver 2 = Driver

Kelowna / Prince George:
- normal Driver only
- NO Victoria supervisor hierarchy is copied.

7) VICTORIA SETTLEMENT RULES PRELOADED
- Driver 2 pays Driver 1 $10/can.
- Driver 1 pays Boss $9/can.
- Driver 1 therefore gets the $1/can spread on Driver 2 cans.
- Driver 2 Orange deliveries: $5 of fee to Driver 1.
- Driver 2 Pink deliveries: $5 of fee to Driver 1.
- Green delivery fee, when charged, belongs to Driver 1.
- Boss settles weekly only with Driver 1 concept is stored in the rule notes.
- Completed-order report calculates cans, boss owed, driver-to-driver amounts and fee flows.

All settlement rules live in database records instead of being buried in storefront code.

8) ORDERS
Customer can:
- choose territory
- add listed products
- receive tier pricing
- choose delivery zone
- enter name / phone / address / notes
- choose Cash / E-transfer / Other
- submit order

System:
- records order number
- snapshots product/zone pricing
- reduces inventory
- rounds final order DOWN to nearest $5
- stores payment method
- lets admin assign driver
- lets admin mark completed
- lets admin override delivery fee

9) ADMIN
Visit:
  /admin

Phone-friendly tabs:
- Orders
- Products
- Zones
- Drivers
- Pricing
- Settlements
- Territories

DEPLOYMENT

This is now a Node application with SQLite.

Dokploy environment variable:
  ADMIN_PASSWORD=choose-a-strong-password

Persistent storage MUST map a Dokploy volume to:
  /data

The database will be:
  /data/pouchesvic.db

The Dockerfile exposes port:
  3000

IMPORTANT PRODUCTION NOTE

This build gives us a proper data model and usable admin foundation, but there are a few things I would add before calling the whole business system finished:

- Actual user accounts / separate login credentials for Super Admin, Operations Admin and individual Drivers.
- Driver-only screens that limit them to their own territory/orders.
- Email notifications and completion links.
- True automatic address-zone detection using geocoding + geofences.
- Weekly date-range settlement reports and finalized settlement/paid records.
- Territory-domain automatic routing.
- Canada-wide shipping toggle/flow.
- PWA manifest/service worker.
- SEO and final branding/photos.
- Backups.
- Stronger production security (CSRF protection, rate limiting, password hashing/user table).

The important architecture is now in place so these can be added without redesigning inventory/territories/orders.
