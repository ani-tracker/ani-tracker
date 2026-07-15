export const SQLITE_SCHEMA_VERSION = 4;

export const SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anime_catalog (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  original_title TEXT,
  premiere_date TEXT,
  premiere_year INTEGER NOT NULL,
  premiere_month INTEGER NOT NULL,
  season TEXT,
  summary TEXT,
  cover_url TEXT,
  rating_score REAL,
  rating_count INTEGER,
  rating_source TEXT,
  external_ids_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anime_catalog_premiere_month
  ON anime_catalog (premiere_year, premiere_month);

CREATE TABLE IF NOT EXISTS anime_alias (
  id TEXT PRIMARY KEY,
  anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  language TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_anime_alias_alias ON anime_alias (alias);

CREATE TABLE IF NOT EXISTS fansub_group (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  source_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS my_anime (
  id TEXT PRIMARY KEY,
  anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  default_fansub_group_id TEXT REFERENCES fansub_group(id) ON DELETE SET NULL,
  auto_download INTEGER NOT NULL DEFAULT 0,
  download_dir TEXT,
  preferred_resolution TEXT,
  preferred_codec TEXT,
  preferred_subtitle TEXT,
  added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_my_anime_status ON my_anime (status);

CREATE TABLE IF NOT EXISTS my_anime_rss_subscription (
  id TEXT PRIMARY KEY,
  my_anime_id TEXT NOT NULL REFERENCES my_anime(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_my_anime_rss_subscription_my_anime
  ON my_anime_rss_subscription (my_anime_id);

CREATE TABLE IF NOT EXISTS anime_source_binding (
  id TEXT PRIMARY KEY,
  anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES release_source(id) ON DELETE CASCADE,
  source_anime_id TEXT NOT NULL,
  source_anime_title TEXT,
  source_url TEXT,
  match_method TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(anime_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_anime_source_binding_source
  ON anime_source_binding (source_id, source_anime_id);

CREATE TABLE IF NOT EXISTS episode (
  id TEXT PRIMARY KEY,
  anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
  episode_no REAL NOT NULL,
  title TEXT,
  air_time TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(anime_id, episode_no)
);

CREATE TABLE IF NOT EXISTS episode_preference (
  id TEXT PRIMARY KEY,
  anime_id TEXT NOT NULL REFERENCES anime_catalog(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episode(id) ON DELETE CASCADE,
  fansub_group_id TEXT REFERENCES fansub_group(id) ON DELETE SET NULL,
  release_id TEXT,
  is_manual_override INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(episode_id)
);

CREATE TABLE IF NOT EXISTS release_source (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  base_url TEXT,
  api_key TEXT,
  rss_url TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  anime_id TEXT REFERENCES anime_catalog(id) ON DELETE SET NULL,
  episode_no REAL,
  fansub_group_id TEXT REFERENCES fansub_group(id) ON DELETE SET NULL,
  source_id TEXT NOT NULL REFERENCES release_source(id) ON DELETE CASCADE,
  source_name TEXT NOT NULL,
  magnet_url TEXT,
  torrent_url TEXT,
  info_hash TEXT,
  size INTEGER,
  resolution TEXT,
  declared_video_codec TEXT,
  normalized_video_codec TEXT,
  subtitle TEXT,
  published_at TEXT NOT NULL,
  seeders INTEGER,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_release_lookup
  ON release (anime_id, episode_no, fansub_group_id, published_at);

CREATE TABLE IF NOT EXISTS download_task (
  id TEXT PRIMARY KEY,
  release_id TEXT,
  anime_id TEXT,
  episode_id TEXT,
  anime_title TEXT,
  episode_no REAL,
  fansub_group_id TEXT,
  fansub_name TEXT,
  correlation_tag TEXT,
  engine TEXT NOT NULL,
  torrent_hash TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  download_speed INTEGER NOT NULL DEFAULT 0,
  upload_speed INTEGER NOT NULL DEFAULT 0,
  eta_seconds INTEGER,
  save_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_download_task_status ON download_task (status);
CREATE INDEX IF NOT EXISTS idx_download_task_torrent_hash ON download_task (torrent_hash);
CREATE INDEX IF NOT EXISTS idx_download_task_correlation_tag ON download_task (correlation_tag);

CREATE TABLE IF NOT EXISTS torrent_file (
  id TEXT PRIMARY KEY,
  download_task_id TEXT NOT NULL REFERENCES download_task(id) ON DELETE CASCADE,
  file_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  selected INTEGER NOT NULL DEFAULT 1,
  UNIQUE(download_task_id, file_index)
);

CREATE TABLE IF NOT EXISTS media_file (
  id TEXT PRIMARY KEY,
  anime_id TEXT NOT NULL,
  episode_id TEXT,
  download_task_id TEXT,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  container TEXT,
  declared_video_codec TEXT,
  detected_video_codec TEXT,
  normalized_video_codec TEXT NOT NULL,
  resolution TEXT,
  bit_depth INTEGER,
  audio_codecs_json TEXT NOT NULL DEFAULT '[]',
  subtitle_tracks_json TEXT NOT NULL DEFAULT '[]',
  duration_seconds INTEGER,
  downloaded_at TEXT,
  probed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_media_file_anime_episode ON media_file (anime_id, episode_id);

CREATE TABLE IF NOT EXISTS notification (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL,
  anime_id TEXT,
  episode_id TEXT,
  download_task_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_created_at ON notification (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification (read_at, created_at DESC);
`;
