import type {
  Anime,
  AppSettings,
  DashboardData,
  DownloadTask,
  Episode,
  EpisodePreference,
  FansubGroup,
  MediaFile,
  MyAnime,
  ReleaseSourceConfig
} from "@shared/domain";

export const fansubGroups: FansubGroup[] = [
  {
    id: "fansub-1",
    name: "喵萌奶茶屋",
    aliases: ["Nekomoe kissaten"],
    sourceIds: ["mikan"]
  },
  {
    id: "fansub-2",
    name: "桜都字幕组",
    aliases: ["Sakurato"],
    sourceIds: ["dmhy"]
  },
  {
    id: "fansub-3",
    name: "LoliHouse",
    aliases: ["LoliHouse"],
    sourceIds: ["mikan", "nyaa"]
  }
];

export const myAnime: MyAnime[] = [
  {
    id: "my-1",
    anime: {
      id: "anime-1",
      title: "葬送的芙莉莲",
      originalTitle: "葬送のフリーレン",
      aliases: [
        {
          id: "alias-1",
          animeId: "anime-1",
          alias: "Frieren: Beyond Journey's End",
          language: "en",
          priority: 80
        },
        {
          id: "alias-2",
          animeId: "anime-1",
          alias: "Sousou no Frieren",
          language: "romaji",
          priority: 90
        }
      ],
      premiereDate: "2023-09-29",
      premiereYear: 2023,
      premiereMonth: 9,
      season: "fall",
      summary: "勇者一行击败魔王后，精灵魔法使重新理解时间与旅途的故事。",
      coverUrl: "",
      externalIds: {
        bangumi: "400602",
        anilist: "154587"
      }
    },
    status: "watching",
    defaultFansubGroupId: "fansub-1",
    autoDownload: true,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredSubtitle: "chs",
    addedAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:00:00.000Z"
  },
  {
    id: "my-2",
    anime: {
      id: "anime-2",
      title: "孤独摇滚！",
      originalTitle: "ぼっち・ざ・ろっく！",
      aliases: [
        {
          id: "alias-3",
          animeId: "anime-2",
          alias: "Bocchi the Rock!",
          language: "en",
          priority: 90
        }
      ],
      premiereDate: "2022-10-09",
      premiereYear: 2022,
      premiereMonth: 10,
      season: "fall",
      summary: "社恐吉他少女和乐队伙伴一起长大的音乐日常。",
      coverUrl: "",
      externalIds: {
        bangumi: "328609",
        anilist: "130003"
      }
    },
    status: "completed",
    defaultFansubGroupId: "fansub-3",
    autoDownload: false,
    preferredResolution: "1080p",
    preferredCodec: "H.265/HEVC",
    preferredSubtitle: "chs",
    addedAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z"
  }
];

export const animeCatalog: Anime[] = myAnime.map((item) => item.anime);

export const downloadTasks: DownloadTask[] = [
  {
    id: "task-1",
    releaseId: "release-1",
    animeId: "anime-1",
    episodeId: "episode-1",
    engine: "embedded",
    torrentHash: "abc123",
    name: "[喵萌奶茶屋] 葬送的芙莉莲 - 05 [1080p][HEVC]",
    status: "downloading",
    progress: 0.64,
    downloadSpeed: 5_420_000,
    uploadSpeed: 210_000,
    etaSeconds: 420,
    savePath: "D:\\Anime\\2023-09\\葬送的芙莉莲",
    files: [
      {
        id: "file-1",
        index: 0,
        name: "[Nekomoe kissaten] Frieren - 05 [1080p][HEVC].mkv",
        size: 1_460_000_000,
        progress: 0.64,
        priority: 1,
        selected: true
      }
    ],
    createdAt: "2026-07-11T13:00:00.000Z"
  }
];

export const episodes: Episode[] = [
  {
    id: "episode-1",
    animeId: "anime-1",
    episodeNo: 5,
    title: "旅途中的魔法",
    airTime: "2026-07-11T12:00:00.000Z",
    status: "downloading"
  },
  {
    id: "episode-2",
    animeId: "anime-1",
    episodeNo: 6,
    title: "下一段旅程",
    airTime: "2026-07-18T12:00:00.000Z",
    status: "upcoming"
  },
  {
    id: "episode-12",
    animeId: "anime-2",
    episodeNo: 12,
    title: "君に朝が降る",
    airTime: "2022-12-25T15:30:00.000Z",
    status: "watched"
  }
];

export const episodePreferences: EpisodePreference[] = [
  {
    id: "episode-pref-1",
    animeId: "anime-1",
    episodeId: "episode-1",
    fansubGroupId: "fansub-1",
    releaseId: "release-1",
    isManualOverride: false
  },
  {
    id: "episode-pref-2",
    animeId: "anime-2",
    episodeId: "episode-12",
    fansubGroupId: "fansub-3",
    isManualOverride: true
  }
];

export const recentCompleted: MediaFile[] = [
  {
    id: "media-1",
    animeId: "anime-2",
    episodeId: "episode-12",
    downloadTaskId: "task-old-1",
    filePath: "D:\\Anime\\2022-10\\孤独摇滚！\\Bocchi the Rock! - 12.mkv",
    fileName: "Bocchi the Rock! - 12.mkv",
    size: 1_220_000_000,
    container: "mkv",
    declaredVideoCodec: "x265",
    detectedVideoCodec: "hevc",
    normalizedVideoCodec: "H.265/HEVC",
    resolution: "1920x1080",
    bitDepth: 10,
    audioCodecs: ["flac"],
    subtitleTracks: ["chs", "jpn"],
    durationSeconds: 1420,
    downloadedAt: "2026-07-11T09:00:00.000Z",
    probedAt: "2026-07-11T09:02:00.000Z"
  }
];

export const sourceConfigs: ReleaseSourceConfig[] = [
  {
    id: "mikan",
    name: "蜜柑计划 RSS",
    kind: "rss",
    enabled: true,
    rssUrl: "https://mikanani.me/RSS/Bangumi",
    tags: ["anime", "rss"]
  },
  {
    id: "dmhy",
    name: "动漫花园",
    kind: "site_adapter",
    enabled: false,
    baseUrl: "https://share.dmhy.org/",
    tags: ["anime", "bt"]
  },
  {
    id: "prowlarr",
    name: "Prowlarr Torznab",
    kind: "torznab",
    enabled: false,
    baseUrl: "http://127.0.0.1:9696",
    tags: ["torznab"]
  }
];

export const appSettings: AppSettings = {
  download: {
    defaultDownloadDir: "D:\\Anime",
    createAnimeFolder: true,
    animeFolderPattern: "{year}-{month}/{title}",
    temporaryDownloadDir: "D:\\Anime\\.downloading",
    defaultTorrentEngine: "embedded",
    embedded: {
      enabled: true,
      listenPort: 51413,
      maxActiveDownloads: 3
    },
    qbittorrent: {
      baseUrl: "http://127.0.0.1:8080",
      username: "admin",
      autoConnect: false
    }
  },
  storage: {
    userDataDir: "%APPDATA%\\AniTracker",
    databasePath: "%APPDATA%\\AniTracker\\ani-tracker.sqlite",
    cacheDir: "%APPDATA%\\AniTracker\\cache",
    logDir: "%APPDATA%\\AniTracker\\logs",
    backupDir: "%APPDATA%\\AniTracker\\backups"
  },
  players: [
    {
      id: "potplayer",
      name: "PotPlayer",
      executablePath: "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe",
      argumentTemplate: "\"{file}\"",
      supportsMadVr: true,
      platform: "windows"
    },
    {
      id: "mpv",
      name: "mpv",
      executablePath: "mpv",
      argumentTemplate: "--force-window=yes \"{file}\"",
      supportsMadVr: false,
      platform: "any"
    }
  ],
  defaultPlayerProfileId: "potplayer",
  automation: {
    scheduledCheckEnabled: true,
    checkIntervalMinutes: 30,
    notifyOnNewEpisode: true,
    autoDownloadEnabledGlobally: true,
    fallbackWhenDefaultFansubMissing: "wait"
  },
  media: {
    ffprobePath: "ffprobe",
    ffprobeTimeoutSeconds: 20,
    videoExtensions: [".mkv", ".mp4", ".avi"]
  }
};

export const dashboard: DashboardData = {
  todayEpisodes: [
    {
      id: "today-1",
      animeTitle: "葬送的芙莉莲",
      episodeNo: 5,
      airTime: "20:00",
      status: "downloading",
      fansubName: "喵萌奶茶屋",
      downloadTaskId: "task-1"
    },
    {
      id: "today-2",
      animeTitle: "新番示例",
      episodeNo: 2,
      airTime: "23:30",
      status: "matched",
      fansubName: "LoliHouse"
    }
  ],
  pendingActions: [
    {
      id: "pending-1",
      title: "等待默认字幕组",
      description: "有 1 集已开播，但默认字幕组还没有发布资源。",
      severity: "warning"
    },
    {
      id: "pending-2",
      title: "下载源未启用",
      description: "动漫花园适配器已添加但还没有启用。",
      severity: "info"
    }
  ],
  activeDownloads: downloadTasks,
  recentCompleted,
  weeklySchedule: [
    {
      day: "周一",
      items: []
    },
    {
      day: "周二",
      items: [
        {
          id: "week-1",
          animeTitle: "葬送的芙莉莲",
          episodeNo: 5,
          airTime: "20:00",
          status: "downloading",
          fansubName: "喵萌奶茶屋"
        }
      ]
    },
    {
      day: "周三",
      items: []
    },
    {
      day: "周四",
      items: []
    },
    {
      day: "周五",
      items: [
        {
          id: "week-2",
          animeTitle: "新番示例",
          episodeNo: 2,
          airTime: "23:30",
          status: "matched",
          fansubName: "LoliHouse"
        }
      ]
    },
    {
      day: "周六",
      items: []
    },
    {
      day: "周日",
      items: []
    }
  ],
  sourceHealth: [
    {
      sourceId: "mikan",
      name: "蜜柑计划 RSS",
      status: "ok",
      lastCheckedAt: "2026-07-11T13:00:00.000Z"
    },
    {
      sourceId: "dmhy",
      name: "动漫花园",
      status: "warning",
      lastCheckedAt: "2026-07-11T12:10:00.000Z"
    }
  ]
};
