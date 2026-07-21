import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  Download,
  ExternalLink,
  FileSearch,
  FolderCog,
  FolderOpen,
  HardDrive,
  KeyRound,
  Languages,
  Monitor,
  Palette,
  PlayCircle,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Smartphone,
  Unplug
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { appApi } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useAsyncData } from "@/lib/use-async-data";
import { useTheme } from "@/components/theme-provider";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { StickyActionBar } from "@/components/page-layout";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import type {
  AutomationSchedulerStatus,
  PlayerDetectionResult,
  QbittorrentManagedStatus,
  RemoteGatewayStatus,
  RemotePairingChallenge
} from "@shared/contracts";
import type { AppSettings } from "@shared/domain";

type SettingsCategoryId =
  | "appearance"
  | "storage"
  | "interface"
  | "remote"
  | "media"
  | "download"
  | "automation";

const settingsCategories: Array<{
  id: SettingsCategoryId;
  label: string;
  icon: typeof Palette;
}> = [
  { id: "appearance", label: "外观", icon: Palette },
  { id: "storage", label: "存储与目录", icon: HardDrive },
  { id: "interface", label: "语言与桌面集成", icon: Monitor },
  { id: "remote", label: "远程设备", icon: Smartphone },
  { id: "media", label: "播放器与媒体", icon: PlayCircle },
  { id: "download", label: "下载核心", icon: Download },
  { id: "automation", label: "自动化", icon: RefreshCw }
];

export function SettingsPage() {
  const { commitAppearance } = useTheme();
  const { data, loading } = useAsyncData(appApi.getSettings, []);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<AppSettings | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("appearance");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [resetState, setResetState] = useState<"idle" | "resetting" | "reset">("idle");
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<AutomationSchedulerStatus | null>(null);
  const [qbManagedStatus, setQbManagedStatus] = useState<QbittorrentManagedStatus | null>(null);
  const [qbManagedAction, setQbManagedAction] = useState<"idle" | "starting" | "stopping" | "restarting">("idle");
  const [remoteStatus, setRemoteStatus] = useState<RemoteGatewayStatus | null>(null);
  const [remotePairing, setRemotePairing] = useState<RemotePairingChallenge | null>(null);
  const [remoteAction, setRemoteAction] = useState<"idle" | "loading" | "creating" | "revoking">("idle");
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [qbTest, setQbTest] = useState<{ state: "idle" | "testing" | "success" | "error"; message?: string }>({
    state: "idle"
  });
  const [playerDetection, setPlayerDetection] = useState<PlayerDetectionResult | null>(null);
  const [playerDetectionState, setPlayerDetectionState] = useState<"idle" | "detecting" | "error">("idle");
  const [playerDetectionError, setPlayerDetectionError] = useState<string | null>(null);
  const settingsReady = !loading && Boolean(data && draft);

  useEffect(() => {
    if (data) {
      setDraft(data);
      setPersistedSettings(data);
      void refreshPlayerDetection(data.players);
    }
  }, [data]);

  useEffect(() => {
    if (!settingsReady) {
      return;
    }
    const sections = settingsCategories
      .map((category) => document.getElementById(`settings-${category.id}`))
      .filter((section): section is HTMLElement => Boolean(section));
    if (sections.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const activeEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        if (activeEntry) {
          setActiveCategory(activeEntry.target.id.replace("settings-", "") as SettingsCategoryId);
        }
      },
      { rootMargin: "-24% 0px -62% 0px", threshold: [0.1, 0.35, 0.65] }
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [settingsReady]);

  useEffect(() => {
    void refreshSchedulerStatus();
    void refreshQbittorrentManagedStatus();
    void refreshRemoteStatus();
  }, []);

  async function refreshSchedulerStatus() {
    setSchedulerStatus(await appApi.getAutomationSchedulerStatus());
  }

  async function refreshQbittorrentManagedStatus() {
    try {
      setQbManagedStatus(await appApi.getQbittorrentManagedStatus());
    } catch (error) {
      setQbTest({
        state: "error",
        message: error instanceof Error ? error.message : "读取 qBittorrent 托管状态失败"
      });
    }
  }

  /** 刷新本机远程网关与已配对设备状态。 */
  async function refreshRemoteStatus() {
    setRemoteAction("loading");
    try {
      const status = await appApi.getRemoteGatewayStatus();
      setRemoteStatus(status);
      if (remotePairing && Date.parse(remotePairing.expiresAt) <= Date.now()) {
        setRemotePairing(null);
      }
      setRemoteError(null);
      return status;
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "读取远程设备状态失败");
      return null;
    } finally {
      setRemoteAction("idle");
    }
  }

  /** 创建两分钟有效的一次性远程配对码。 */
  async function createRemotePairingCode() {
    setRemoteAction("creating");
    try {
      setRemotePairing(await appApi.createRemotePairingCode());
      setRemoteError(null);
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "创建远程配对码失败");
    } finally {
      setRemoteAction("idle");
    }
  }

  /** 吊销指定远程设备的访问令牌。 */
  async function revokeRemoteDevice(deviceId: string) {
    setRemoteAction("revoking");
    setRevokingDeviceId(deviceId);
    try {
      setRemoteStatus(await appApi.revokeRemoteDevice(deviceId));
      setRemotePairing(null);
      setRemoteError(null);
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : "吊销远程设备失败");
    } finally {
      setRevokingDeviceId(null);
      setRemoteAction("idle");
    }
  }

  /** 复制本地 CA 下载地址，便于在移动设备中安装证书。 */
  async function copyAuthorityCertificateUrl() {
    if (!remoteStatus?.certificate) {
      return;
    }
    try {
      await navigator.clipboard.writeText(`${remoteStatus.baseUrl}/ani-tracker-ca.crt`);
      toast.success("CA 下载地址已复制");
    } catch {
      toast.error("复制失败，请手动复制 CA 下载地址");
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4" aria-label="正在加载设置">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data || !draft) {
    return (
      <Alert variant="destructive">
        <AlertTitle>设置加载失败</AlertTitle>
        <AlertDescription>请重新进入设置页或重启应用后再试。</AlertDescription>
      </Alert>
    );
  }

  async function saveSettings() {
    if (!draft) {
      return;
    }

    setSaveState("saving");
    try {
      const saved = await appApi.updateSettings(draft);
      setDraft(saved);
      setPersistedSettings(saved);
      commitAppearance(saved.appearance);
      const [, , remote] = await Promise.all([
        refreshSchedulerStatus(),
        refreshQbittorrentManagedStatus(),
        refreshRemoteStatus(),
        refreshPlayerDetection(saved.players)
      ]);
      setSaveState("saved");
      if (saved.network.remoteAccess.lanEnabled && (!remote?.lanEnabled || remote.lastError)) {
        toast.warning("设置已保存，但局域网 HTTPS 启动失败，已恢复本机访问");
      } else {
        toast.success("设置已保存");
      }
      window.setTimeout(() => setSaveState("idle"), 1200);
    } catch (error) {
      setSaveState("idle");
      toast.error(error instanceof Error ? error.message : "设置保存失败");
    }
  }

  async function resetSettingsToDefaults() {
    setResetState("resetting");
    try {
      const saved = await appApi.resetSettingsToDefaults();
      setDraft(saved);
      setPersistedSettings(saved);
      commitAppearance(saved.appearance);
      await refreshPlayerDetection(saved.players);
      setQbTest({ state: "idle" });
      await refreshSchedulerStatus();
      await refreshQbittorrentManagedStatus();
      setResetState("reset");
      window.setTimeout(() => setResetState("idle"), 1200);
    } catch (error) {
      setResetState("idle");
      toast.error(error instanceof Error ? error.message : "恢复默认设置失败");
      throw error;
    }
  }

  /** 在内置 qBittorrent-nox 与外部 WebUI 之间切换。 */
  function updateQbittorrentMode(mode: "managed" | "external") {
    if (!draft) {
      return;
    }
    const managed = mode === "managed";
    setDraft({
      ...draft,
      download: {
        ...draft.download,
        defaultTorrentEngine: "qbittorrent",
        embedded: {
          ...draft.download.embedded,
          enabled: false
        },
        qbittorrent: {
          ...draft.download.qbittorrent,
          autoConnect: managed,
          managed: {
            ...draft.download.qbittorrent.managed,
            enabled: managed
          }
        }
      }
    });
    setQbTest({ state: "idle" });
  }

  /** 保存当前配置并测试 qBittorrent WebUI 连接。 */
  async function testQbittorrent() {
    if (!draft) {
      return;
    }

    setQbTest({ state: "testing", message: "正在测试 qBittorrent 连接..." });
    try {
      const saved = await appApi.updateSettings(draft);
      setDraft(saved);
      setPersistedSettings(saved);
      commitAppearance(saved.appearance);
      const result = await appApi.testQbittorrent();
      setQbTest({
        state: result.ok ? "success" : "error",
        message: result.ok ? `${result.message}，当前任务 ${result.taskCount ?? 0} 个` : result.message
      });
      await refreshQbittorrentManagedStatus();
    } catch (error) {
      setQbTest({
        state: "error",
        message: error instanceof Error ? error.message : "qBittorrent 连接测试失败"
      });
    }
  }

  async function startQbittorrentManaged() {
    if (!draft) {
      return;
    }

    setQbManagedAction("starting");
    try {
      const saved = await appApi.updateSettings(draft);
      setDraft(saved);
      setPersistedSettings(saved);
      commitAppearance(saved.appearance);
      const status = await appApi.startQbittorrentManaged();
      setQbManagedStatus(status);
      setQbTest({
        state: status.lastError ? "error" : "success",
        message: status.lastError ?? "托管 qBittorrent 已启动"
      });
    } catch (error) {
      setQbTest({
        state: "error",
        message: error instanceof Error ? error.message : "托管 qBittorrent 启动失败"
      });
    } finally {
      setQbManagedAction("idle");
    }
  }

  async function stopQbittorrentManaged() {
    setQbManagedAction("stopping");
    try {
      const status = await appApi.stopQbittorrentManaged();
      setQbManagedStatus(status);
      setQbTest({ state: "idle", message: "托管 qBittorrent 已停止" });
    } catch (error) {
      setQbTest({
        state: "error",
        message: error instanceof Error ? error.message : "托管 qBittorrent 停止失败"
      });
    } finally {
      setQbManagedAction("idle");
    }
  }

  /** 保存设置后重启内置 qBittorrent-nox 进程。 */
  async function restartQbittorrentManaged() {
    if (!draft) {
      return;
    }

    setQbManagedAction("restarting");
    try {
      const saved = await appApi.updateSettings(draft);
      setDraft(saved);
      setPersistedSettings(saved);
      commitAppearance(saved.appearance);
      if (qbManagedStatus?.running) {
        await appApi.stopQbittorrentManaged();
      }
      const status = await appApi.startQbittorrentManaged();
      setQbManagedStatus(status);
      setQbTest({
        state: status.lastError ? "error" : "success",
        message: status.lastError ?? "内置 qBittorrent-nox 已重启"
      });
    } catch (error) {
      setQbTest({
        state: "error",
        message: error instanceof Error ? error.message : "内置 qBittorrent-nox 重启失败"
      });
    } finally {
      setQbManagedAction("idle");
    }
  }

  /** 使用系统浏览器打开当前 qBittorrent WebUI。 */
  async function openQbittorrentWebUi() {
    const url = qbManagedStatus?.webUiUrl || draft?.download.qbittorrent.baseUrl;
    if (!url) {
      return;
    }
    try {
      await appApi.openExternal(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开 qBittorrent WebUI 失败");
    }
  }

  /** 探测当前系统可用的播放器路径并刷新状态。 */
  async function refreshPlayerDetection(players = draft?.players, notify = false) {
    if (!players) {
      return;
    }
    setPlayerDetectionState("detecting");
    try {
      const result = await appApi.detectPlayers(players);
      setPlayerDetection(result);
      setPlayerDetectionError(null);
      if (notify) {
        if (result.detectedProfileId) {
          toast.success("播放器探测完成");
        } else {
          toast.warning("未探测到可用播放器");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "播放器探测失败";
      setPlayerDetectionError(message);
      if (notify) {
        toast.error(message);
      }
    } finally {
      setPlayerDetectionState("idle");
    }
  }

  /** 更新指定播放器的可执行文件路径并等待用户保存。 */
  function updatePlayerPath(profileId: string, executablePath: string) {
    if (!draft) {
      return;
    }
    setDraft({
      ...draft,
      players: draft.players.map((player) => player.id === profileId ? { ...player, executablePath } : player)
    });
    setPlayerDetection(null);
    setPlayerDetectionError(null);
  }

  /** 打开系统文件选择器并写入当前播放器路径。 */
  async function selectPlayerExecutable(profileId: string) {
    if (!draft) {
      return;
    }
    const player = draft.players.find((item) => item.id === profileId);
    if (!player) {
      return;
    }
    try {
      const selectedPath = await appApi.selectPlayerExecutable({
        profileId,
        currentPath: player.executablePath
      });
      if (!selectedPath) {
        return;
      }
      const players = draft.players.map((item) => item.id === profileId
        ? { ...item, executablePath: selectedPath }
        : item);
      setDraft({ ...draft, players });
      await refreshPlayerDetection(players);
      toast.success("播放器路径已选择，请保存设置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "播放器文件选择失败");
    }
  }

  /** 滚动至指定设置分区，并让导航立即反映当前选择。 */
  function navigateToCategory(categoryId: SettingsCategoryId) {
    setActiveCategory(categoryId);
    document.getElementById(`settings-${categoryId}`)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start"
    });
  }

  const playerOptions = draft.players.filter((player) =>
    !playerDetection || playerDetection.candidates.some((candidate) => candidate.profileId === player.id)
  );
  const selectedPlayerId = draft.defaultPlayerProfileId ?? "auto";
  const selectedPlayer = draft.players.find((player) => player.id === selectedPlayerId);
  const selectedCandidate = playerDetection?.candidates.find((candidate) => candidate.profileId === selectedPlayerId);
  const autoCandidate = playerDetection?.candidates.find((candidate) => candidate.profileId === playerDetection.detectedProfileId);
  const hasUnsavedChanges = persistedSettings ? !areSettingsEqual(draft, persistedSettings) : false;

  return (
    <div className={cn("flex min-w-0 flex-col gap-6", hasUnsavedChanges && "pb-20")}>
      <div className="sticky top-[calc(4rem+var(--safe-area-top))] z-20 -mx-4 border-b bg-background px-4 md:top-0 md:-mx-5 md:px-5 xl:-mx-6 xl:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">设置</h1>
              {hasUnsavedChanges && (
                <Badge className="gap-1.5 rounded-full" tone="primary-soft">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
                  有未保存修改
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">目录、下载引擎、播放器和自动化规则集中管理。</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setResetDialogOpen(true)}
              disabled={resetState === "resetting" || saveState === "saving"}
            >
              <RotateCcw data-icon="inline-start" />
              {resetState === "resetting" ? "恢复中" : resetState === "reset" ? "已恢复" : "恢复默认"}
            </Button>
          </div>
        </header>
        <div className="pb-3 lg:hidden">
          <SettingsCategorySelect activeCategory={activeCategory} onNavigate={navigateToCategory} />
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <SettingsCategoryNavigation activeCategory={activeCategory} onNavigate={navigateToCategory} />

        <div className="flex min-w-0 flex-col gap-12">
          <SettingsCategory
            description="明暗模式、主题预设与导入的用户主题包。"
            id="appearance"
            title="外观"
          >
            <AppearanceSettingsSection
              appearance={draft.appearance}
              onChange={(appearance) => setDraft({ ...draft, appearance })}
            />
          </SettingsCategory>

          <SettingsCategory
            description="默认下载目录、未完成目录和应用用户数据位置。"
            id="storage"
            title="存储与目录"
          >
            <div className="flex flex-col gap-5">
        <SettingsSection title="下载目录" description="支持全局默认目录，后续单部番可以覆盖。">
          <div className="flex flex-col gap-4">
            <ToggleSetting
              icon={<FolderCog className="h-4 w-4" />}
              label="创建番剧目录"
              description="按目录模板为每部追番生成独立保存目录。"
              checked={draft.download.createAnimeFolder}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  download: { ...draft.download, createAnimeFolder: value }
                })
              }
            />
            <TextSetting
              icon={<FolderCog className="h-4 w-4" />}
              label="默认下载目录"
              value={draft.download.defaultDownloadDir}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  download: {
                    ...draft.download,
                    defaultDownloadDir: value
                  }
                })
              }
            />
            <TextSetting
              label="临时下载目录"
              value={draft.download.temporaryDownloadDir ?? ""}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  download: {
                    ...draft.download,
                    temporaryDownloadDir: value
                  }
                })
              }
            />
            <TextSetting
              label="番剧目录模板（{year}、{month}、{title}、{originalTitle}）"
              value={draft.download.animeFolderPattern}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  download: {
                    ...draft.download,
                    animeFolderPattern: value
                  }
                })
              }
            />
          </div>
        </SettingsSection>

        <SettingsSection title="用户数据" description="数据库、缓存、日志和备份都应随用户数据目录迁移。">
          <div className="flex flex-col gap-4">
            <TextSetting
              icon={<HardDrive className="h-4 w-4" />}
              label="用户数据目录"
              value={draft.storage.userDataDir}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  storage: {
                    ...draft.storage,
                    userDataDir: value
                  }
                })
              }
            />
            <SettingRow label="数据库" value={draft.storage.databasePath} />
            <SettingRow label="缓存" value={draft.storage.cacheDir} />
            <SettingRow label="日志" value={draft.storage.logDir} />
          </div>
        </SettingsSection>
      </div>

          </SettingsCategory>

          <SettingsCategory
            description="语言、标题显示规则和桌面端后台行为。"
            id="interface"
            title="语言与桌面集成"
          >
            <div className="flex flex-col gap-5">

      <SettingsSection title="语言与标题" description="界面语言保持固定，番剧元数据按当前标题策略展示和检索。">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <SettingRow icon={<Languages className="h-4 w-4" />} label="界面语言" value="简体中文" />
          <SettingRow label="标题显示" value="中文优先，副标题显示原名" />
          <SettingRow label="搜索名称" value="标题、原名、罗马音、英文名和自定义别名" />
        </div>
      </SettingsSection>

      <SettingsSection title="桌面集成" description="控制后台运行、系统登录启动等本地桌面行为。">
        <div className="grid gap-4 lg:grid-cols-2">
          <ToggleSetting
            icon={<Monitor className="h-4 w-4" />}
            label="关闭到托盘"
            description="关闭主窗口后继续保留后台扫描和提醒。"
            checked={draft.desktop.minimizeToTray}
            onChange={(value) =>
              setDraft({
                ...draft,
                desktop: {
                  ...draft.desktop,
                  minimizeToTray: value
                }
              })
            }
          />
          <ToggleSetting
            icon={<Power className="h-4 w-4" />}
            label="开机启动"
            description="系统登录后自动启动 Ani Tracker。"
            checked={draft.desktop.launchAtLogin}
            onChange={(value) =>
              setDraft({
                ...draft,
                desktop: {
                  ...draft.desktop,
                  launchAtLogin: value
                }
              })
            }
          />
        </div>
      </SettingsSection>
            </div>
          </SettingsCategory>

          <SettingsCategory
            description="局域网 HTTPS、一次性配对码和已配对设备的访问范围。"
            id="remote"
            title="远程设备"
          >
      <SettingsSection title="远程服务与设备" description="管理通过一次性配对码登记的浏览器和移动设备。">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ToggleSetting
              icon={<Smartphone />}
              label="局域网 HTTPS"
              description="显式开启后允许同一私有网络中的设备访问；不会开放裸 HTTP 或公网映射。"
              checked={draft.network.remoteAccess.lanEnabled}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  network: {
                    ...draft.network,
                    remoteAccess: {
                      ...draft.network.remoteAccess,
                      lanEnabled: value
                    }
                  }
                })
              }
            />
            <NumberSetting
              label="远程服务端口"
              value={draft.network.remoteAccess.port}
              min={1024}
              max={65_535}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  network: {
                    ...draft.network,
                    remoteAccess: {
                      ...draft.network.remoteAccess,
                      port: value
                    }
                  }
                })
              }
            />
          </div>

          <Alert>
            <Monitor />
            <AlertTitle>{remoteStatus?.lanEnabled ? "局域网 HTTPS 已开启" : "当前仅开放本机回环访问"}</AlertTitle>
            <AlertDescription>
              {remoteStatus?.lanEnabled
                ? "首次连接前需在移动设备中信任 Ani Tracker 本地 CA；设备令牌仅保存在内存中，应用重启后需重新配对。"
                : "启用局域网 HTTPS 并保存后，移动设备才能通过同一私有网络访问。设备令牌仅保存在内存中。"}
            </AlertDescription>
          </Alert>

          {remoteStatus?.lastError && (
            <Alert variant="destructive">
              <Unplug />
              <AlertTitle>远程服务启动失败</AlertTitle>
              <AlertDescription>{remoteStatus.lastError}</AlertDescription>
            </Alert>
          )}

          {remoteError && (
            <Alert variant="destructive">
              <Unplug />
              <AlertTitle>远程服务操作失败</AlertTitle>
              <AlertDescription>{remoteError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={remoteStatus?.running ? "green" : "amber"}>
                {remoteStatus?.running ? "服务运行中" : "服务未运行"}
              </Badge>
              <span className="break-all text-sm text-muted-foreground">
                {remoteStatus?.baseUrl ?? "正在读取服务地址"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => void refreshRemoteStatus()}
                disabled={remoteAction !== "idle"}
              >
                <RefreshCw data-icon="inline-start" />
                刷新状态
              </Button>
              <Button onClick={() => void createRemotePairingCode()} disabled={!remoteStatus?.running || remoteAction !== "idle"}>
                <KeyRound data-icon="inline-start" />
                生成配对码
              </Button>
            </div>
          </div>

          {remoteStatus?.lanEnabled && (
            <div className="flex flex-col gap-3">
              <div className="text-sm font-medium">局域网访问地址</div>
              <div className="flex flex-wrap gap-2">
                {remoteStatus.addresses.map((address) => (
                  <Badge key={address}>https://{address}:{remoteStatus.port}</Badge>
                ))}
              </div>
              {remoteStatus.certificate && (
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 break-all">CA 下载：{remoteStatus.baseUrl}/ani-tracker-ca.crt</span>
                    <Button
                      aria-label="复制 CA 下载地址"
                      variant="ghost"
                      className="size-11 shrink-0 p-0 md:size-9"
                      onClick={() => void copyAuthorityCertificateUrl()}
                    >
                      <Copy />
                    </Button>
                  </div>
                  <span className="break-all">证书指纹：{remoteStatus.certificate.fingerprint}</span>
                  <span>证书到期：{formatDateTime(remoteStatus.certificate.expiresAt)}</span>
                </div>
              )}
            </div>
          )}

          {remotePairing && (
            <Alert>
              <KeyRound />
              <AlertTitle>一次性配对码：{remotePairing.code}</AlertTitle>
              <AlertDescription>有效期至 {formatDateTime(remotePairing.expiresAt)}，使用后立即失效。</AlertDescription>
            </Alert>
          )}

          {remoteStatus && remoteStatus.devices.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {remoteStatus.devices.map((device) => (
                <Card key={device.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Smartphone />
                      {device.name}
                    </CardTitle>
                    <CardDescription>
                      配对于 {formatDateTime(device.createdAt)} · 最近访问 {formatDateTime(device.lastAccessedAt ?? undefined)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    {device.scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)}
                  </CardContent>
                  <CardFooter>
                    <Button
                      variant="outline"
                      onClick={() => void revokeRemoteDevice(device.id)}
                      disabled={remoteAction !== "idle"}
                    >
                      <Unplug data-icon="inline-start" />
                      {revokingDeviceId === device.id ? "正在吊销" : "吊销设备"}
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          ) : (
            <Alert>
              <Smartphone />
              <AlertTitle>暂无已配对设备</AlertTitle>
              <AlertDescription>生成配对码后，在同源 PWA 配对页登记设备。</AlertDescription>
            </Alert>
          )}
        </div>
      </SettingsSection>

          </SettingsCategory>

          <SettingsCategory
            description="默认播放器、可执行文件路径与媒体文件扫描参数。"
            id="media"
            title="播放器与媒体"
          >
            <div className="flex flex-col gap-5">

      <SettingsSection title="播放器配置" description="按当前操作系统提供播放器选项。">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <Field>
              <FieldLabel htmlFor="default-player">默认播放器</FieldLabel>
              <Select
                value={selectedPlayerId}
                onValueChange={(value) => setDraft({ ...draft, defaultPlayerProfileId: value })}
              >
                <SelectTrigger id="default-player">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="auto">自动</SelectItem>
                    {playerOptions.map((player) => (
                      <SelectItem key={player.id} value={player.id}>{player.name}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button
              variant="outline"
              onClick={() => void refreshPlayerDetection(draft.players, true)}
              disabled={playerDetectionState === "detecting"}
            >
              <RefreshCw data-icon="inline-start" />
              {playerDetectionState === "detecting" ? "探测中" : "重新探测"}
            </Button>
          </div>

          {selectedPlayerId === "auto" ? (
            <Alert>
              <PlayCircle />
              <AlertTitle>{autoCandidate ? `自动选择：${autoCandidate.name}` : "未探测到可用播放器"}</AlertTitle>
              <AlertDescription className="break-all">
                {autoCandidate?.resolvedPath ?? "请安装播放器，或选择具体播放器并设置可执行文件路径。"}
              </AlertDescription>
            </Alert>
          ) : selectedPlayer ? (
            <Field data-invalid={Boolean(playerDetection && !selectedCandidate?.available)}>
              <FieldLabel htmlFor="player-executable-path">可执行文件路径</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id="player-executable-path"
                  value={selectedPlayer.executablePath}
                  aria-invalid={Boolean(playerDetection && !selectedCandidate?.available)}
                  onChange={(event) => updatePlayerPath(selectedPlayer.id, event.target.value)}
                />
                <InputGroupAddon>
                  <InputGroupButton
                    onClick={() => void selectPlayerExecutable(selectedPlayer.id)}
                    aria-label="选择播放器可执行文件"
                    title="选择播放器可执行文件"
                  >
                    <FolderOpen />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge tone={selectedCandidate?.available ? "green" : selectedCandidate ? "amber" : "neutral"}>
                  {selectedCandidate?.available ? "路径可用" : selectedCandidate ? "路径不可用" : "待探测"}
                </Badge>
                {selectedCandidate?.resolvedPath && <span className="break-all">{selectedCandidate.resolvedPath}</span>}
              </div>
            </Field>
          ) : null}

          {playerDetectionError && (
            <Alert variant="destructive">
              <PlayCircle />
              <AlertTitle>播放器探测失败</AlertTitle>
              <AlertDescription>{playerDetectionError}</AlertDescription>
            </Alert>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="媒体探测" description="用于读取已下载视频的编码、分辨率、音轨和字幕轨。">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
          <TextSetting
            icon={<FileSearch className="h-4 w-4" />}
            label="ffprobe 路径"
            value={draft.media.ffprobePath}
            onChange={(value) =>
              setDraft({
                ...draft,
                media: {
                  ...draft.media,
                  ffprobePath: value
                }
              })
            }
          />
          <NumberSetting
            label="探测超时"
            value={draft.media.ffprobeTimeoutSeconds}
            suffix="秒"
            min={3}
            onChange={(value) =>
              setDraft({
                ...draft,
                media: {
                  ...draft.media,
                  ffprobeTimeoutSeconds: value
                }
              })
            }
          />
        </div>
        <div className="mt-4">
          <TextSetting
            label="视频扩展名"
            value={draft.media.videoExtensions.join(", ")}
            onChange={(value) =>
              setDraft({
                ...draft,
                media: {
                  ...draft.media,
                  videoExtensions: parseExtensions(value)
                }
              })
            }
          />
        </div>
      </SettingsSection>

            </div>
          </SettingsCategory>

          <SettingsCategory
            description="qBittorrent 连接方式、速率限制、做种策略和内置进程状态。"
            id="download"
            title="下载核心"
          >

      <Card className="overflow-hidden shadow-none">
        <CardHeader className="gap-3 border-b bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle><h3>引擎配置</h3></CardTitle>
            <CardDescription>
              {draft.download.qbittorrent.managed.enabled
                ? "由应用托管 qBittorrent-nox，并自动使用本机 WebUI。"
                : "连接已单独运行的 qBittorrent WebUI。"}
            </CardDescription>
          </div>
          <ToggleGroup
            aria-label="qBittorrent 运行方式"
            className="grid w-full shrink-0 grid-cols-2 sm:w-auto"
            onValueChange={(value) => value && updateQbittorrentMode(value as "managed" | "external")}
            type="single"
            value={draft.download.qbittorrent.managed.enabled ? "managed" : "external"}
            variant="outline"
          >
            <ToggleGroupItem className="h-auto min-h-9 whitespace-normal px-3" value="managed">
              内置 qBittorrent-nox
            </ToggleGroupItem>
            <ToggleGroupItem className="h-auto min-h-9 whitespace-normal px-3" value="external">
              外部 qBittorrent WebUI
            </ToggleGroupItem>
          </ToggleGroup>
        </CardHeader>
        <CardContent className="pt-4 sm:pt-5">
          <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <FieldGroup className="gap-4">
              <TextSetting
                label="WebUI 地址"
                value={draft.download.qbittorrent.baseUrl}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: { ...draft.download.qbittorrent, baseUrl: value }
                    }
                  })
                }
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextSetting
                  label="用户名"
                  value={draft.download.qbittorrent.username}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: { ...draft.download.qbittorrent, username: value }
                      }
                    })
                  }
                />
                <TextSetting
                  label="密码"
                  type="password"
                  value={draft.download.qbittorrent.password ?? ""}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: { ...draft.download.qbittorrent, password: value }
                      }
                    })
                  }
                />
              </div>
              <Field orientation="horizontal">
                <FieldLabel>运行模式</FieldLabel>
                <span className="text-right text-sm text-muted-foreground">
                  {draft.download.qbittorrent.managed.enabled ? "内置 qBittorrent-nox" : "外部 WebUI"}
                </span>
              </Field>
              <Field data-disabled={!draft.download.qbittorrent.managed.enabled} orientation="horizontal">
                <FieldLabel htmlFor="qbittorrent-auto-start">随应用启动</FieldLabel>
                <Switch
                  checked={draft.download.qbittorrent.managed.enabled && draft.download.qbittorrent.autoConnect}
                  disabled={!draft.download.qbittorrent.managed.enabled}
                  id="qbittorrent-auto-start"
                  onCheckedChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: { ...draft.download.qbittorrent, autoConnect: value }
                      }
                    })
                  }
                />
              </Field>
              <Button onClick={() => void testQbittorrent()} disabled={qbTest.state === "testing"}>
                {qbTest.state === "testing" ? "测试并保存中" : "测试连接并保存"}
              </Button>
              {qbTest.message && (
                <p className={cn(
                  "text-sm",
                  qbTest.state === "error" ? "text-destructive" : "text-muted-foreground"
                )}>
                  {qbTest.message}
                </p>
              )}
            </FieldGroup>

            <Separator className="hidden h-full lg:block" orientation="vertical" />
            <Separator className="lg:hidden" />

            <FieldGroup className="gap-4">
              <div>
                <h3 className="font-medium">流量与做种控制</h3>
                <p className="mt-1 text-sm text-muted-foreground">限速为 0 时不限制传输速度。</p>
              </div>
              <SpeedLimitSetting
                label="全局下载限制"
                value={draft.download.qbittorrent.downloadLimitKiBps ?? 0}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: { ...draft.download.qbittorrent, downloadLimitKiBps: value }
                    }
                  })
                }
              />
              <SpeedLimitSetting
                label="全局上传限制"
                value={draft.download.qbittorrent.uploadLimitKiBps ?? 0}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: { ...draft.download.qbittorrent, uploadLimitKiBps: value }
                    }
                  })
                }
              />
              <Field orientation="horizontal">
                <FieldLabel className="cursor-pointer" htmlFor="qbittorrent-seeding-limits">
                  启用做种限制
                </FieldLabel>
                <Switch
                  checked={draft.download.qbittorrent.seedingLimits.enabled}
                  id="qbittorrent-seeding-limits"
                  onCheckedChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            enabled: value,
                            ratioEnabled: value,
                            timeEnabled: value
                          }
                        }
                      }
                    })
                  }
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberSetting
                  disabled={!draft.download.qbittorrent.seedingLimits.enabled}
                  label="分享率"
                  min={0.1}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            ratioEnabled: true,
                            ratioLimit: value
                          }
                        }
                      }
                    })
                  }
                  step={0.1}
                  suffix="倍"
                  value={draft.download.qbittorrent.seedingLimits.ratioLimit}
                />
                <NumberSetting
                  disabled={!draft.download.qbittorrent.seedingLimits.enabled}
                  label="做种时间"
                  min={1}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            timeEnabled: true,
                            timeLimitMinutes: value
                          }
                        }
                      }
                    })
                  }
                  suffix="分钟"
                  value={draft.download.qbittorrent.seedingLimits.timeLimitMinutes}
                />
              </div>
            </FieldGroup>
          </div>

          {draft.download.qbittorrent.managed.enabled && qbManagedStatus?.lastError && (
            <Alert className="mt-5" variant="destructive">
              <AlertTitle>内置进程异常</AlertTitle>
              <AlertDescription className="break-all">{qbManagedStatus.lastError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        {draft.download.qbittorrent.managed.enabled && (
          <CardFooter className="flex-col justify-between gap-3 border-t bg-muted/30 pt-4 sm:flex-row sm:pt-5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <Badge tone={qbManagedStatus?.running ? "green" : "neutral"}>
                {qbManagedStatus?.running ? "运行中" : "未运行"}
              </Badge>
              <span>PID: {qbManagedStatus?.pid ?? "--"}</span>
              <span>架构: {qbManagedStatus?.arch ?? "--"}</span>
              <Button className="h-auto min-h-0 min-w-0 px-0 text-xs" onClick={() => void openQbittorrentWebUi()} variant="ghost">
                <ExternalLink data-icon="inline-start" />
                <span className="truncate underline underline-offset-4">
                  {qbManagedStatus?.webUiUrl || draft.download.qbittorrent.baseUrl}
                </span>
              </Button>
            </div>
            <div className="flex w-full shrink-0 gap-2 sm:w-auto">
              <Button
                className="flex-1 sm:flex-none"
                disabled={qbManagedAction !== "idle"}
                onClick={() => void (qbManagedStatus?.running ? stopQbittorrentManaged() : startQbittorrentManaged())}
                variant="outline"
              >
                <Power data-icon="inline-start" />
                {qbManagedAction === "starting"
                  ? "启动中"
                  : qbManagedAction === "stopping"
                    ? "停止中"
                    : qbManagedStatus?.running
                      ? "停止服务"
                      : "启动服务"}
              </Button>
              <Button
                className="flex-1 sm:flex-none"
                disabled={qbManagedAction !== "idle"}
                onClick={() => void restartQbittorrentManaged()}
              >
                <RefreshCw data-icon="inline-start" />
                {qbManagedAction === "restarting" ? "重启中" : "重启服务"}
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>

          </SettingsCategory>

          <SettingsCategory
            description="扫描节奏、新集通知、自动下载和默认字幕组缺失策略。"
            id="automation"
            title="自动化"
          >

      <SettingsSection title="扫描与下载规则">
        <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <SelectSetting
            label="定时扫描"
            value={draft.automation.scheduledCheckEnabled ? "on" : "off"}
            options={[
              { label: "开启", value: "on" },
              { label: "关闭", value: "off" }
            ]}
            onChange={(value) =>
              setDraft({
                ...draft,
                automation: {
                  ...draft.automation,
                  scheduledCheckEnabled: value === "on"
                }
              })
            }
          />
          <NumberSetting
            label="扫描间隔"
            value={draft.automation.checkIntervalMinutes}
            suffix="分钟"
            min={5}
            onChange={(value) =>
              setDraft({
                ...draft,
                automation: {
                  ...draft.automation,
                  checkIntervalMinutes: value
                }
              })
            }
          />
          <SelectSetting
            label="新集提醒"
            value={draft.automation.notifyOnNewEpisode ? "on" : "off"}
            options={[
              { label: "开启", value: "on" },
              { label: "关闭", value: "off" }
            ]}
            onChange={(value) =>
              setDraft({
                ...draft,
                automation: {
                  ...draft.automation,
                  notifyOnNewEpisode: value === "on"
                }
              })
            }
          />
          <SelectSetting
            label="全局自动下载"
            value={draft.automation.autoDownloadEnabledGlobally ? "on" : "off"}
            options={[
              { label: "开启", value: "on" },
              { label: "关闭", value: "off" }
            ]}
            onChange={(value) =>
              setDraft({
                ...draft,
                automation: {
                  ...draft.automation,
                  autoDownloadEnabledGlobally: value === "on"
                }
              })
            }
          />
          <SelectSetting
            label="默认字幕组缺失"
            value={draft.automation.fallbackWhenDefaultFansubMissing}
            options={[
              { label: "等待", value: "wait" },
              { label: "候补字幕组", value: "candidate" },
              { label: "只提醒", value: "notify_only" }
            ]}
            onChange={(value) =>
              setDraft({
                ...draft,
                automation: {
                  ...draft.automation,
                  fallbackWhenDefaultFansubMissing: value as AppSettings["automation"]["fallbackWhenDefaultFansubMissing"]
                }
              })
            }
          />
        </div>
        <div className="mt-5 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <SettingRow label="调度状态" value={formatSchedulerState(schedulerStatus)} />
          <SettingRow label="下次扫描" value={formatDateTime(schedulerStatus?.nextRunAt)} />
          <SettingRow label="上次扫描" value={formatDateTime(schedulerStatus?.lastRunAt)} />
          <SettingRow label="手动冷却至" value={formatDateTime(schedulerStatus?.manualCooldownUntil)} />
        </div>
        {schedulerStatus?.lastResult && (
          <div className="mt-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            上次结果：下载 {schedulerStatus.lastResult.downloaded.length}，跳过{" "}
            {schedulerStatus.lastResult.skipped.length}，错误 {schedulerStatus.lastResult.errors.length}
          </div>
        )}
      </SettingsSection>
          </SettingsCategory>
        </div>
      </div>

      {hasUnsavedChanges && (
        <StickyActionBar className="justify-center bg-background/95">
          <span className="text-sm text-muted-foreground">更改尚未保存</span>
          <Button onClick={saveSettings} disabled={saveState === "saving" || resetState === "resetting"}>
            <Save data-icon="inline-start" />
            {saveState === "saving" ? "保存中" : "保存设置"}
          </Button>
        </StickyActionBar>
      )}

      <ConfirmActionDialog
        confirmLabel="恢复默认"
        description="当前未保存的设置将被平台默认配置覆盖，主题与运行参数也会立即更新。"
        onConfirm={resetSettingsToDefaults}
        onOpenChange={setResetDialogOpen}
        open={resetDialogOpen}
        title="确认恢复默认设置？"
      />
    </div>
  );
}

function parseExtensions(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 以持久化快照为准判断草稿是否真的发生变更。 */
function areSettingsEqual(left: AppSettings, right: AppSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 渲染随主内容滚动吸顶的桌面设置分区导航。 */
function SettingsCategoryNavigation({
  activeCategory,
  onNavigate
}: {
  activeCategory: SettingsCategoryId;
  onNavigate: (categoryId: SettingsCategoryId) => void;
}) {
  return (
    <aside className="sticky top-24 hidden max-h-[calc(100dvh-7rem)] min-w-0 self-start overflow-y-auto pr-4 lg:block">
      <nav aria-label="设置分区" className="flex flex-col gap-1 border-r">
        {settingsCategories.map((category) => {
          const Icon = category.icon;
          return (
            <Button
              aria-current={activeCategory === category.id ? "location" : undefined}
              className="w-full justify-start"
              data-active={activeCategory === category.id}
              key={category.id}
              onClick={() => onNavigate(category.id)}
              variant="navigation"
            >
              <Icon aria-hidden="true" data-icon="inline-start" />
              <span className="truncate">{category.label}</span>
            </Button>
          );
        })}
      </nav>
    </aside>
  );
}

/** 渲染固定在页面标题下方的小屏幕设置分区选择器。 */
function SettingsCategorySelect({
  activeCategory,
  onNavigate
}: {
  activeCategory: SettingsCategoryId;
  onNavigate: (categoryId: SettingsCategoryId) => void;
}) {
  const selectId = useId();

  return (
    <Field>
      <FieldLabel className="sr-only" htmlFor={selectId}>设置分区</FieldLabel>
      <Select value={activeCategory} onValueChange={(value) => onNavigate(value as SettingsCategoryId)}>
        <SelectTrigger id={selectId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {settingsCategories.map((category) => (
              <SelectItem key={category.id} value={category.id}>{category.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** 提供符合 Stitch 长页层级的设置分区锚点。 */
function SettingsCategory({
  id,
  title,
  description,
  children
}: {
  id: SettingsCategoryId;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="scroll-mt-[calc(12rem+var(--safe-area-top))] lg:scroll-mt-24" id={`settings-${id}`}>
      <header className="border-b pb-3">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function formatSchedulerState(status: AutomationSchedulerStatus | null): string {
  if (!status) {
    return "未知";
  }

  if (status.inFlight) {
    return "扫描中";
  }

  if (!status.enabled) {
    return "已关闭";
  }

  return status.running ? `运行中，每 ${status.intervalMinutes} 分钟` : "未启动";
}

function formatDateTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : "--";
}

/** 统一设置页分区的标题、说明和内容布局。 */
function SettingsSection({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden shadow-none">
      <CardHeader className="border-b bg-muted/50">
        <CardTitle><h3>{title}</h3></CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="pt-4 sm:pt-5">{children}</CardContent>
    </Card>
  );
}

/** 渲染文本类设置项。 */
function TextSetting({
  icon,
  label,
  value,
  type = "text",
  onChange
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  type?: "text" | "password";
  onChange: (value: string) => void;
}) {
  const inputId = useId();

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>
        {icon && <span className="text-primary">{icon}</span>}
        {label}
      </FieldLabel>
      <Input
        id={inputId}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** 渲染支持触控和键盘操作的开关设置项。 */
function ToggleSetting({
  icon,
  label,
  description,
  checked,
  disabled = false,
  onChange
}: {
  icon?: ReactNode;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const switchId = useId();
  const descriptionId = `${switchId}-description`;

  return (
    <Field
      className="min-h-[104px] items-center justify-between rounded-md border p-4 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-60"
      data-disabled={disabled}
      orientation="horizontal"
    >
      <FieldLabel className="min-w-0 flex-1 cursor-pointer flex-col items-start" htmlFor={switchId}>
        <span className="flex items-center gap-2">
          {icon && <span className="text-primary">{icon}</span>}
          {label}
        </span>
        <span id={descriptionId} className="text-sm font-normal leading-6 text-muted-foreground">
          {description}
        </span>
      </FieldLabel>
      <Switch
        aria-describedby={descriptionId}
        id={switchId}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </Field>
  );
}

/** 渲染带单位提示的数值设置项。 */
function NumberSetting({
  label,
  value,
  suffix,
  min = 0,
  max,
  step = 1,
  disabled = false,
  onChange
}: {
  label: string;
  value: number;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const inputId = useId();

  return (
    <Field className="rounded-md border p-4 data-[disabled=true]:opacity-60" data-disabled={disabled}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          className="min-w-0 flex-1"
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </Field>
  );
}

/** 渲染可精确输入的 qBittorrent 速率限制滑块。 */
function SpeedLimitSetting({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const inputId = useId();
  const normalizedValue = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  const sliderMax = Math.max(10_240, Math.ceil(normalizedValue / 1_024) * 1_024);

  /** 统一约束输入值，避免向设置草稿写入负数或非数字。 */
  function updateValue(nextValue: number) {
    onChange(Number.isFinite(nextValue) ? Math.max(0, Math.round(nextValue)) : 0);
  }

  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor={inputId}>{label} (KiB/s)</FieldLabel>
        <Input
          className="h-8 w-28 shrink-0 text-right tabular-nums"
          id={inputId}
          min={0}
          onChange={(event) => updateValue(Number(event.target.value))}
          step={128}
          type="number"
          value={normalizedValue}
        />
      </div>
      <Slider
        aria-label={`${label}，单位 KiB/s`}
        max={sliderMax}
        min={0}
        onValueChange={(nextValue) => updateValue(nextValue[0] ?? 0)}
        step={128}
        value={[normalizedValue]}
      />
    </Field>
  );
}

/** 渲染使用 Radix Select 的选项设置项。 */
function SelectSetting({
  label,
  value,
  options,
  disabled = false,
  onChange
}: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selectId = useId();

  return (
    <Field className="rounded-md border p-4" data-disabled={disabled}>
      <FieldLabel htmlFor={selectId}>{label}</FieldLabel>
      <Select disabled={disabled} value={value} onValueChange={onChange}>
        <SelectTrigger id={selectId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

/** 展示不可编辑的设置摘要。 */
function SettingRow({
  icon,
  label,
  value
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      {icon && <div className="mt-0.5 text-primary">{icon}</div>}
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-1 break-all rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{value}</div>
      </div>
    </div>
  );
}
