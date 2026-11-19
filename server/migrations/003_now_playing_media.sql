-- Which media item a screen is showing right now, so the dashboard can preview it.
-- No foreign key: the player reports it, and a deleted media item should just show no preview.
ALTER TABLE screens ADD COLUMN now_playing_media_id TEXT;
