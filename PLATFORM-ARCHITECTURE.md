# PouchesVic Reusable Commerce Platform Extension

This extension keeps the current PouchesVic storefront/order engine intact while adding business-neutral expansion points.

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
- Address-first storefront flow. Mapbox public-token support provides live address suggestions while typing; if the token is not configured, the current manual-zone flow remains as a safe fallback.
- Server-side delivery-zone resolution from coordinates plus saved exceptions for an exact address, an entire street, or a known customer. A saved exception can choose any active zone and optionally override the delivery fee (including $0).
- Territory-specific editable Store Notice and Help / Customer Service block, both hidden until Admin turns them on.
- Optional product star-rating display with simple Admin-set rating/review count. Product Ratings is OFF by default.
- Optional Delivery Method screen is installed but OFF by default. Current PouchesVic continues to assume local same-day delivery.
- Guest/ accountless customer recognition using normalized phone/email/address+name. Existing order history is backfilled when the extension starts, so known repeat customers can be recognized without registration.
- Returning/Loyal Customer badges on customer confirmation and driver/admin views. These are informational only and do not change ID/compliance behavior.
- Persistent internal customer notes shared across future orders. Drivers can add a customer note; Control Room can view/edit customer records, confirm matches, correct contact data, and merge duplicate customer records.

The design deliberately stops short of a full loyalty-points/CRM system. The goal is fast guest checkout plus just enough history to improve service without forcing accounts.

## Order notification recipients and social links

Control Room can maintain multiple independently enabled business order-notification email recipients. New-order notifications contain the full order and are recorded per order/recipient so the same recipient is not notified twice. This path runs only after order creation; later status, delivery, payment, and completion changes do not invoke it. Customer confirmation email remains separate.

Control Room can also maintain ordered Facebook, Instagram, TikTok, X, YouTube, and custom links. A master storefront switch and an individual link switch must both be on, and the link must contain a valid HTTP(S) URL, before its small footer icon is exposed publicly. With no eligible links, the storefront renders no social-link container.
