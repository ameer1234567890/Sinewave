-- Thumbnails for web page media: a screenshot of the page (or its share image) shown on the dashboard card.
ALTER TABLE media ADD COLUMN preview TEXT;            -- file name inside the item's media folder, e.g. preview.jpg
ALTER TABLE media ADD COLUMN preview_at TEXT;         -- when it was captured, used to bust the browser cache
ALTER TABLE media ADD COLUMN preview_error TEXT;      -- why the last capture failed, shown on the card
