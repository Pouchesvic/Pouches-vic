# Pouches Local Reusable Commerce Platform

Pouches Local is one application with multiple customer-facing **Locals**. Local Victoria, Local Sooke, Local Prince George and future Locals share the same Control Room, driver app and database while keeping their own storefront settings, hours, routing and physical inventory.

## Local and driver model
- A Local is a storefront/service area, not a driver.
- Every driver has an individual four-digit PIN and exact physical inventory.
- Each Local chooses a Main driver and may choose a separate Small Orders driver plus quantity threshold.
- A driver may belong to more than one Local. Login is always into a specific Local context.
- Admin may grant a driver **Can manage Local hours** without giving that driver full Control Room access.
- New Locals default to 9:00 AM–5:00 PM daily.
- The default same-day guarantee cutoff is 15 minutes before closing. Orders inside the final 15 minutes require the customer to acknowledge that delivery today is not guaranteed. At closing, same-day ordering stops.
- A final 45-minute delivery window may extend at most 15 minutes beyond the final closing time.

## Company Home — Prince George
- Local Prince George is Company Home.
- The Company Owner/Bossman has a normal driver login plus Company Home stock and sales views.
- Bossman’s own completed sales create no debt back to Company.
- Company Reserve lives at Prince George and is hidden from storefronts until moved to a driver.
- Bossman or Admin can move physical stock from Company Reserve or a driver to any valid driver/Local.
- Driver supervisors can hand stock onward to other drivers. Cross-Local moves preserve the stock accounting pool.
- The Control Room **Stock** screen is the single Company-wide “where every can is” view and supports Add Stock, Move Stock and Fix Stock.
- Lost, stolen, found and recount corrections are audited. Driver and storefront availability use the same inventory records.


## Installed but off / switchable
- Generic business labels (business name, product field labels, item unit labels)
- Pickup module flag
- Shipping module flag
- External courier module flag
- External scanner API flag
- Driver dispatch remains switchable and independent
- Barcode inventory is installed and enabled
- Customer support -> live driver update notifications are installed and enabled

## Marketplace socket prepared
The full Craigslist/Facebook Marketplace-style multi-seller UI is intentionally not activated yet. The schema is prepared now with:
- businesses
- sellers
- seller locations
- seller ownership fields on products/orders
- payout and permissions JSON hooks
- fulfillment configuration hooks

This avoids a future database teardown when the marketplace layer is added.

## Barcode inventory
Products now support optional generic fields including `generic_name`, `category`, `variant`, `sku`, `barcode`, `barcode_format`, `unit_label`, `business_id`, `seller_id`, and `attributes_json`.

Inventory can be received by:
1. phone camera via `/scanner`
2. Bluetooth/USB keyboard-style barcode scanner
3. scanner apps that type into the focused barcode field
4. external HTTP scanner integrations using a Control Room-generated bearer token when the External Scanner API module is switched on

Unknown barcodes can be linked to an existing product or used to create a new product once. Future scans then receive inventory immediately.

## Live support updates
The Control Room order screen receives an additional Customer Support section. Address/delivery-instruction changes write to the live order record, add an audit event, set `support_updated_at`, and send a Web Push alert to the assigned driver. The existing driver order endpoint always returns the current order record, so opening the alert shows the newest instructions.

The driver's `ON THE WAY` status remains optional. The server does not require it before `completed`.

## Driver order photos
Order photos are installed and enabled, but optional by default. Photos are stored as image files under the persistent `DATA_DIR/order-photos` volume; SQLite stores only metadata and links them to the order/driver. This avoids bloating the database and lets permanent deletion actually reclaim image storage.

Drivers can:
- take a new photo from the phone camera
- add one or multiple photos already on the phone
- label a photo General, Pickup, or Delivery
- attach photos before an order is completed
- delete their own active photo and retake it when Admin allows driver deletion

Control Room can:
- view photos from the order record, including completed/old orders
- archive photos without deleting the image
- restore archived photos
- permanently delete the image to free storage

Photo policy is already switchable per platform configuration. Current PouchesVic defaults are:
- photos enabled: YES
- photos required: NO
- require pickup photo before ON THE WAY: NO
- require delivery photo before COMPLETED: NO
- driver may delete/retake own photos: YES
- maximum photos per order: 8

For a future DoorDash-style business, Admin can switch on pickup and/or delivery photo requirements. The driver UI then blocks the corresponding status transition until the required photo exists. PouchesVic keeps `ON THE WAY` optional because its pickup-photo requirement remains off.

The photo table includes a `storage_provider`/`storage_key` abstraction so local persistent-volume storage can later be migrated to object storage (for example an S3-compatible service) without changing the order/photo relationship or driver/admin UI contract.

## Storefront/customer controls added Aug 17, 2026
The platform extension now also installs the lightweight customer/storefront features requested for the current PouchesVic flow:

- Separate 19+ entry screen with Control Room ON/OFF switch. This is separate from the checkout ID/age acknowledgement, which remains mandatory on every order.
- Customer checkout does **not** use live GPS, Mapbox, address autocomplete, polygon lookup, or automatic zone detection. The customer types the delivery address, views the Local’s still delivery-area map, and selects the matching delivery area.
- The server validates that the selected delivery area is active and calculates the delivery fee itself, so a customer request cannot forge a cheaper fee.
- The only live-map behavior is in the driver/admin order view: tapping the customer address opens normal map/navigation directions.
- Local-specific editable Store Notice and Help / Customer Service block, both hidden until Admin turns them on.
- Optional product star-rating display with simple Admin-set rating/review count. Product Ratings is OFF by default.
- Optional Delivery Method screen is installed but OFF by default. Current Pouches Local storefronts continue to use local same-day delivery.
- Guest/ accountless customer recognition using normalized phone/email/address+name. Existing order history is backfilled when the extension starts, so known repeat customers can be recognized without registration.
- Returning/Loyal Customer badges on customer confirmation and driver/admin views. These are informational only and do not change ID/compliance behavior.
- Persistent internal customer notes shared across future orders. Drivers can add a customer note; Control Room can view/edit customer records, confirm matches, correct contact data, and merge duplicate customer records.

The design deliberately stops short of a full loyalty-points/CRM system. The goal is fast guest checkout plus just enough history to improve service without forcing accounts.

## Order notification recipients and social links

Control Room can maintain multiple independently enabled business order-notification email recipients. New-order notifications contain the full order and are recorded per order/recipient so the same recipient is not notified twice. This path runs only after order creation; later status, delivery, payment, and completion changes do not invoke it. Customer confirmation email remains separate.

Control Room can also maintain ordered Facebook, Instagram, TikTok, X, YouTube, and custom links. A master storefront switch and an individual link switch must both be on, and the link must contain a valid HTTP(S) URL, before its small footer icon is exposed publicly. With no eligible links, the storefront renders no social-link container.
