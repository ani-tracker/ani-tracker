import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  Copy,
  FileSearch,
  FolderCog,
  FolderOpen,
  HardDrive,
  KeyRound,
  Languages,
  Monitor,
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
import { Field, FieldLabel } from "@/components/ui/field";
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
import { Switch } from "@/components/ui/switch";
import { appApi } from "@/lib/api";
import { useAsyncData } from "@/lib/use-async-data";
import { useTheme } from "@/components/theme-provider";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { AppearanceSettingsSection } from "./AppearanceSettingsSection";
import type {
  AutomationSchedulerStatus,
  PlayerDetectionResult,
  QbittorrentManagedStatus,
  RemoteGatewayStatus,
  RemotePairingChallenge
} from "@shared/contracts";
import type { AppSettings } from "@shared/domain";

export function SettingsPage() {
  const { commitAppearance } = useTheme();
  const { data, loading } = useAsyncData(appApi.getSettings, []);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [resetState, setResetState] = useState<"idle" | "resetting" | "reset">("idle");
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [schedulerStatus, setSchedulerStatus] = useState<AutomationSchedulerStatus | null>(null);
  const [qbManagedStatus, setQbManagedStatus] = useState<QbittorrentManagedStatus | null>(null);
  const [qbManagedAction, setQbManagedAction] = useState<"idle" | "starting" | "stopping">("idle");
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

  useEffect(() => {
    if (data) {
      setDraft(data);
      void refreshPlayerDetection(data.players);
    }
  }, [data]);

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

  async function testQbittorrent() {
    if (!draft) {
      return;
    }

    setQbTest({ state: "testing", message: "正在测试 qBittorrent 连接..." });
    const saved = await appApi.updateSettings(draft);
    setDraft(saved);
    const result = await appApi.testQbittorrent();
    setQbTest({
      state: result.ok ? "success" : "error",
      message: result.ok ? `${result.message}，当前任务 ${result.taskCount ?? 0} 个` : result.message
    });
  }

  async function startQbittorrentManaged() {
    if (!draft) {
      return;
    }

    setQbManagedAction("starting");
    try {
      const saved = await appApi.updateSettings(draft);
      setDraft(saved);
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

  const playerOptions = draft.players.filter((player) =>
    !playerDetection || playerDetection.candidates.some((candidate) => candidate.profileId === player.id)
  );
  const selectedPlayerId = draft.defaultPlayerProfileId ?? "auto";
  const selectedPlayer = draft.players.find((player) => player.id === selectedPlayerId);
  const selectedCandidate = playerDetection?.candidates.find((candidate) => candidate.profileId === selectedPlayerId);
  const autoCandidate = playerDetection?.candidates.find((candidate) => candidate.profileId === playerDetection.detectedProfileId);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">目录、下载引擎、播放器和提醒规则集中管理。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setResetDialogOpen(true)}
            disabled={resetState === "resetting" || saveState === "saving"}
          >
            <RotateCcw data-icon="inline-start" />
            {resetState === "resetting" ? "恢复中" : resetState === "reset" ? "已恢复" : "恢复默认"}
          </Button>
          <Button onClick={saveSettings} disabled={saveState === "saving" || resetState === "resetting"}>
            <Save data-icon="inline-start" />
            {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : "保存"}
          </Button>
        </div>
      </div>

      <AppearanceSettingsSection
        appearance={draft.appearance}
        onChange={(appearance) => setDraft({ ...draft, appearance })}
      />

      <div className="grid gap-5 xl:grid-cols-2">
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

      <SettingsSection title="远程设备" description="管理通过一次性配对码登记的浏览器和移动设备。">
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

      <SettingsSection title="下载核心配置">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 rounded-md border p-4">
            <div>
              <div className="font-medium">
                {draft.download.qbittorrent.managed.enabled ? "内置 qBittorrent-nox" : "外部 qBittorrent WebUI"}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {draft.download.qbittorrent.managed.enabled
                  ? "默认随应用启动无界面的 qBittorrent-nox，并自动选择 10000 以上的可用 WebUI 端口。"
                  : "用于接入你已经单独运行的 qBittorrent WebUI，应用不会托管启动或关闭外部进程。"}
              </p>
            </div>
            <TextSetting
              label="WebUI 地址"
              value={draft.download.qbittorrent.baseUrl}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  download: {
                    ...draft.download,
                    qbittorrent: {
                      ...draft.download.qbittorrent,
                      baseUrl: value
                    }
                  }
                })
              }
            />
            <TextSetting
              label="用户名"
              value={draft.download.qbittorrent.username}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  download: {
                    ...draft.download,
                    qbittorrent: {
                      ...draft.download.qbittorrent,
                      username: value
                    }
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
                    qbittorrent: {
                      ...draft.download.qbittorrent,
                      password: value
                    }
                  }
                })
              }
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectSetting
                label="运行模式"
                value={draft.download.qbittorrent.managed.enabled ? "managed" : "external"}
                options={[
                  { label: "内置 qBittorrent-nox", value: "managed" },
                  { label: "外部 WebUI", value: "external" }
                ]}
                onChange={(value) =>
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
                        autoConnect: value === "managed",
                        managed: {
                          ...draft.download.qbittorrent.managed,
                          enabled: value === "managed"
                        }
                      }
                    }
                  })
                }
              />
              <SelectSetting
                label="随应用启动"
                value={
                  draft.download.qbittorrent.managed.enabled && draft.download.qbittorrent.autoConnect ? "on" : "off"
                }
                options={[
                  { label: "开启", value: "on" },
                  { label: "关闭", value: "off" }
                ]}
                disabled={!draft.download.qbittorrent.managed.enabled}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: {
                        ...draft.download.qbittorrent,
                        autoConnect: value === "on"
                      }
                    }
                  })
                }
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <NumberSetting
                label="下载限速"
                value={draft.download.qbittorrent.downloadLimitKiBps ?? 0}
                suffix="KiB/s"
                min={0}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: {
                        ...draft.download.qbittorrent,
                        downloadLimitKiBps: value
                      }
                    }
                  })
                }
              />
              <NumberSetting
                label="上传限速"
                value={draft.download.qbittorrent.uploadLimitKiBps ?? 0}
                suffix="KiB/s"
                min={0}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: {
                        ...draft.download.qbittorrent,
                        uploadLimitKiBps: value
                      }
                    }
                  })
                }
              />
            </div>
            <p className="text-sm text-muted-foreground">限速值填 0 表示不限制。</p>
            <div className="flex flex-col gap-3 border-t pt-4">
              <ToggleSetting
                label="启用做种"
                description="默认关闭；关闭后下载完成即暂停。开启后可按分享率或时长停止，任务和文件始终保留。"
                checked={draft.download.qbittorrent.seedingLimits.enabled}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    download: {
                      ...draft.download,
                      qbittorrent: {
                        ...draft.download.qbittorrent,
                        seedingLimits: {
                          ...draft.download.qbittorrent.seedingLimits,
                          enabled: value
                        }
                      }
                    }
                  })
                }
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <ToggleSetting
                  label="按分享率停止"
                  description="上传量与下载量达到指定比例后停止做种。"
                  checked={draft.download.qbittorrent.seedingLimits.ratioEnabled}
                  disabled={!draft.download.qbittorrent.seedingLimits.enabled}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            ratioEnabled: value
                          }
                        }
                      }
                    })
                  }
                />
                <NumberSetting
                  label="目标分享率"
                  value={draft.download.qbittorrent.seedingLimits.ratioLimit}
                  suffix="倍"
                  min={0.1}
                  step={0.1}
                  disabled={
                    !draft.download.qbittorrent.seedingLimits.enabled ||
                    !draft.download.qbittorrent.seedingLimits.ratioEnabled
                  }
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            ratioLimit: value
                          }
                        }
                      }
                    })
                  }
                />
                <ToggleSetting
                  label="按时长停止"
                  description="从任务进入做种状态开始累计做种时间。"
                  checked={draft.download.qbittorrent.seedingLimits.timeEnabled}
                  disabled={!draft.download.qbittorrent.seedingLimits.enabled}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            timeEnabled: value
                          }
                        }
                      }
                    })
                  }
                />
                <NumberSetting
                  label="目标做种时长"
                  value={draft.download.qbittorrent.seedingLimits.timeLimitMinutes}
                  suffix="分钟"
                  min={1}
                  disabled={
                    !draft.download.qbittorrent.seedingLimits.enabled ||
                    !draft.download.qbittorrent.seedingLimits.timeEnabled
                  }
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      download: {
                        ...draft.download,
                        qbittorrent: {
                          ...draft.download.qbittorrent,
                          seedingLimits: {
                            ...draft.download.qbittorrent.seedingLimits,
                            timeLimitMinutes: value
                          }
                        }
                      }
                    })
                  }
                />
              </div>
            </div>
            {draft.download.qbittorrent.managed.enabled ? (
              <div className="rounded-md border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium">内置进程状态</div>
                    <div className="mt-1 break-all text-muted-foreground">
                      {formatQbittorrentManagedSummary(qbManagedStatus)}
                    </div>
                    <div className="mt-1 break-all text-xs text-muted-foreground">
                      二进制：{qbManagedStatus?.binaryPath ?? "未找到项目内置 qBittorrent-nox"}
                    </div>
                    {qbManagedStatus?.lastError && (
                      <Alert className="mt-2" variant="destructive">
                        <AlertTitle>内置进程异常</AlertTitle>
                        <AlertDescription className="break-all">{qbManagedStatus.lastError}</AlertDescription>
                      </Alert>
                    )}
                  </div>
                  <Badge tone={qbManagedStatus?.running ? "green" : "neutral"}>
                    {qbManagedStatus?.running ? "运行中" : "未运行"}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void startQbittorrentManaged()}
                    disabled={qbManagedAction !== "idle"}
                  >
                    {qbManagedAction === "starting" ? "启动中" : "启动内置"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void stopQbittorrentManaged()}
                    disabled={!qbManagedStatus?.running || qbManagedAction !== "idle"}
                  >
                    {qbManagedAction === "stopping" ? "停止中" : "停止内置"}
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="flex items-center gap-3">
              <Button variant="outline" onClick={testQbittorrent} disabled={qbTest.state === "testing"}>
                {qbTest.state === "testing" ? "测试中" : "测试连接"}
              </Button>
              {qbTest.message && (
                <span
                  className={
                    qbTest.state === "error"
                      ? "text-sm text-destructive"
                      : qbTest.state === "success"
                        ? "text-sm text-primary"
                        : "text-sm text-muted-foreground"
                  }
                >
                  {qbTest.message}
                </span>
              )}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="自动化">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
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
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
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

function formatQbittorrentManagedSummary(status: QbittorrentManagedStatus | null): string {
  if (!status) {
    return "状态读取中";
  }

  const state = status.running ? `运行中，PID ${status.pid ?? "--"}` : "未运行";
  return `${state}，${status.platform}/${status.arch}，WebUI ${status.webUiUrl}`;
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
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
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
