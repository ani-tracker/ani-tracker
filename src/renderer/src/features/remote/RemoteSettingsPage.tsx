import { Download, MonitorCog, Palette, Play, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Page, PageHeader, PageHeading } from "@/components/page-layout";
import { readStoredSubtitleScale, storeSubtitleScale } from "@/features/player/subtitle-scale";
import { appApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import type {
  AutomationSchedulerStatus,
  EmbeddedTorrentCoreStatus,
  QbittorrentManagedStatus,
  RemotePlaybackRequestMode
} from "@shared/contracts";
import type { AppSettings } from "@shared/domain";
import { PLAYER_SUBTITLE_SCALES, type PlayerSubtitleScale } from "@shared/player-contract";
import type { ThemeMode } from "@shared/theme";
import { readRemotePlaybackMode, storeRemotePlaybackMode } from "./remote-playback-preferences";

type HostAction = "embedded-start" | "embedded-stop" | "embedded-restart" | "qb-start" | "qb-stop" | "qb-restart";

/** 渲染远程设备偏好与受控的 PC 宿主配置。 */
export function RemoteSettingsPage() {
  const { appearance, clearPreview, commitAppearance, previewAppearance, themePacks } = useTheme();
  const [appearanceDraft, setAppearanceDraft] = useState(appearance);
  const [savedAppearance, setSavedAppearance] = useState(appearance);
  const [playbackMode, setPlaybackMode] = useState<RemotePlaybackRequestMode>(readRemotePlaybackMode);
  const [subtitleScale, setSubtitleScale] = useState<PlayerSubtitleScale>(readStoredSubtitleScale);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [automationStatus, setAutomationStatus] = useState<AutomationSchedulerStatus | null>(null);
  const [embeddedStatus, setEmbeddedStatus] = useState<EmbeddedTorrentCoreStatus | null>(null);
  const [qbStatus, setQbStatus] = useState<QbittorrentManagedStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingAutomation, setSavingAutomation] = useState(false);
  const [hostAction, setHostAction] = useState<HostAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appearanceDirty = appearanceDraft.themeMode !== savedAppearance.themeMode
    || appearanceDraft.themePackId !== savedAppearance.themePackId;

  useEffect(() => {
    void refreshHostSettings();
  }, []);

  useEffect(() => () => clearPreview(), [clearPreview]);

  /** 从 PC 网关刷新允许远程查看的设置与宿主状态。 */
  async function refreshHostSettings(): Promise<void> {
    setLoading(true);
    try {
      const [nextSettings, nextAutomation, nextEmbedded, nextQb] = await Promise.all([
        appApi.getSettings(),
        appApi.getAutomationSchedulerStatus(),
        appApi.getEmbeddedTorrentStatus(),
        appApi.getQbittorrentManagedStatus()
      ]);
      setSettings(nextSettings);
      setAutomationStatus(nextAutomation);
      setEmbeddedStatus(nextEmbedded);
      setQbStatus(nextQb);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "远程设置加载失败");
    } finally {
      setLoading(false);
    }
  }

  /** 预览当前远程设备的主题模式。 */
  function updateThemeMode(themeMode: ThemeMode): void {
    const next = { ...appearanceDraft, themeMode };
    setAppearanceDraft(next);
    previewAppearance(next);
  }

  /** 预览当前远程设备使用的主题包。 */
  function updateThemePack(themePackId: string): void {
    const next = { ...appearanceDraft, themePackId };
    setAppearanceDraft(next);
    previewAppearance(next);
  }

  /** 将外观预览保存到当前远程设备。 */
  function saveAppearance(): void {
    if (!commitAppearance(appearanceDraft)) {
      toast.error("当前设备外观保存失败");
      return;
    }
    setSavedAppearance(appearanceDraft);
    toast.success("当前设备外观已保存");
    console.info("[remote] 当前设备外观已保存", {
      themeMode: appearanceDraft.themeMode,
      themePackId: appearanceDraft.themePackId
    });
  }

  /** 保存当前远程设备的默认播放偏好。 */
  function updatePlaybackPreferences(mode: RemotePlaybackRequestMode, scale: PlayerSubtitleScale): void {
    setPlaybackMode(mode);
    setSubtitleScale(scale);
    storeRemotePlaybackMode(mode);
    storeSubtitleScale(scale);
  }

  /** 保存 PC 自动化计划，不触发一次性扫描。 */
  async function updateAutomation(patch: Partial<AppSettings["automation"]>): Promise<void> {
    if (!settings) return;
    setSavingAutomation(true);
    try {
      const saved = await appApi.updateSettings({
        automation: { ...settings.automation, ...patch }
      });
      setSettings(saved);
      setAutomationStatus(await appApi.getAutomationSchedulerStatus());
      setError(null);
      toast.success("PC 自动化计划已保存");
      console.info("[remote] PC 自动化计划已更新", {
        enabled: saved.automation.scheduledCheckEnabled,
        intervalMinutes: saved.automation.checkIntervalMinutes
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "自动化计划保存失败";
      setError(message);
      toast.error(message);
    } finally {
      setSavingAutomation(false);
    }
  }

  /** 通过远程 RPC 控制 PC 下载核心进程。 */
  async function runHostAction(action: HostAction): Promise<void> {
    setHostAction(action);
    try {
      if (action === "embedded-start") setEmbeddedStatus(await appApi.startEmbeddedTorrent());
      if (action === "embedded-stop") setEmbeddedStatus(await appApi.stopEmbeddedTorrent());
      if (action === "embedded-restart") setEmbeddedStatus(await appApi.restartEmbeddedTorrent());
      if (action === "qb-start") setQbStatus(await appApi.startQbittorrentManaged());
      if (action === "qb-stop") setQbStatus(await appApi.stopQbittorrentManaged());
      if (action === "qb-restart") {
        await appApi.stopQbittorrentManaged();
        setQbStatus(await appApi.startQbittorrentManaged());
      }
      setError(null);
      toast.success("PC 下载核心状态已更新");
      console.info("[remote] PC 下载核心操作完成", { action });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "下载核心操作失败";
      setError(message);
      toast.error(message);
    } finally {
      setHostAction(null);
    }
  }

  return (
    <Page>
      <PageHeader>
        <PageHeading description="设置仅作用于当前远程设备，PC 宿主配置会明确标注。" title="设置" />
        <Button disabled={loading} onClick={() => void refreshHostSettings()} variant="outline">
          <RefreshCw className={loading ? "animate-spin" : undefined} data-icon="inline-start" />
          刷新状态
        </Button>
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="min-w-0 border-b pb-7">
        <div className="flex items-center justify-between gap-3">
          <SectionHeading icon={<Palette />} title="当前设备外观" />
          <Button disabled={!appearanceDirty} onClick={saveAppearance} size="compact">
            <Save data-icon="inline-start" />
            保存外观
          </Button>
        </div>
        <FieldGroup className="mt-4 grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="remote-theme-mode">明暗模式</FieldLabel>
            <Select value={appearanceDraft.themeMode} onValueChange={(value) => updateThemeMode(value as ThemeMode)}>
              <SelectTrigger id="remote-theme-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="system">跟随系统</SelectItem>
                  <SelectItem value="light">浅色</SelectItem>
                  <SelectItem value="dark">深色</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="remote-theme-pack">主题</FieldLabel>
            <Select value={appearanceDraft.themePackId} onValueChange={updateThemePack}>
              <SelectTrigger id="remote-theme-pack"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {themePacks.map((pack) => <SelectItem key={pack.id} value={pack.id}>{pack.name}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      </section>

      <section className="min-w-0 border-b pb-7">
        <SectionHeading icon={<Play />} title="远程播放" />
        <FieldGroup className="mt-4 grid gap-4 md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="remote-playback-mode">默认播放模式</FieldLabel>
            <Select
              value={playbackMode}
              onValueChange={(value) => updatePlaybackPreferences(value as RemotePlaybackRequestMode, subtitleScale)}
            >
              <SelectTrigger id="remote-playback-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="direct">优先直传</SelectItem>
                  <SelectItem value="transcode">优先实时转码</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>直传失败时播放器仍会自动切换为实时转码。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="remote-subtitle-scale">字幕大小</FieldLabel>
            <Select
              value={String(subtitleScale)}
              onValueChange={(value) => updatePlaybackPreferences(playbackMode, Number(value) as PlayerSubtitleScale)}
            >
              <SelectTrigger id="remote-subtitle-scale"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {PLAYER_SUBTITLE_SCALES.map((scale) => (
                    <SelectItem key={scale} value={String(scale)}>{scale}%</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
      </section>

      <section className="min-w-0 border-b pb-7">
        <SectionHeading icon={<Download />} title="PC 下载核心" />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <HostProcessCard
            busy={hostAction?.startsWith("embedded") ?? false}
            description="PC 内置 torrent-core"
            enabled={embeddedStatus?.enabled ?? false}
            running={embeddedStatus?.running ?? false}
            title="内置下载核心"
            onAction={(action) => void runHostAction(`embedded-${action}` as HostAction)}
          />
          <HostProcessCard
            busy={hostAction?.startsWith("qb") ?? false}
            description="PC 托管 qBittorrent-nox"
            enabled={qbStatus?.enabled ?? false}
            running={qbStatus?.running ?? false}
            title="qBittorrent"
            onAction={(action) => void runHostAction(`qb-${action}` as HostAction)}
          />
        </div>
      </section>

      <section className="min-w-0">
        <SectionHeading icon={<MonitorCog />} title="PC 自动化计划" />
        <FieldGroup className="mt-4 gap-5">
          <Field className="items-center justify-between gap-4" orientation="horizontal">
            <div>
              <FieldLabel htmlFor="remote-automation-enabled">自动检查更新</FieldLabel>
              <FieldDescription>由 PC 宿主按计划执行，远程端不提供手动扫描。</FieldDescription>
            </div>
            <Switch
              checked={settings?.automation.scheduledCheckEnabled ?? false}
              disabled={!settings || savingAutomation}
              id="remote-automation-enabled"
              onCheckedChange={(checked) => void updateAutomation({ scheduledCheckEnabled: checked })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="remote-automation-interval">检查间隔（分钟）</FieldLabel>
            <div className="flex max-w-sm gap-2">
              <Input
                disabled={!settings || savingAutomation}
                id="remote-automation-interval"
                min={5}
                onChange={(event) => setSettings((current) => current ? {
                  ...current,
                  automation: { ...current.automation, checkIntervalMinutes: Number(event.target.value) }
                } : current)}
                type="number"
                value={settings?.automation.checkIntervalMinutes ?? 30}
              />
              <Button
                disabled={!settings || savingAutomation}
                onClick={() => void updateAutomation({ checkIntervalMinutes: Math.max(5, settings?.automation.checkIntervalMinutes ?? 30) })}
              >
                <Save data-icon="inline-start" />保存
              </Button>
            </div>
          </Field>
          {automationStatus && (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge tone={automationStatus.enabled ? "green" : "neutral"}>{automationStatus.enabled ? "计划已启用" : "计划已停用"}</Badge>
              <span>下次执行：{automationStatus.nextRunAt ? new Date(automationStatus.nextRunAt).toLocaleString() : "未安排"}</span>
            </div>
          )}
        </FieldGroup>
      </section>
    </Page>
  );
}

/** 渲染设置分区标题。 */
function SectionHeading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <h2 className="flex items-center gap-2 text-base font-semibold">{icon}{title}</h2>;
}

/** 渲染一个可受控的 PC 宿主进程状态。 */
function HostProcessCard({
  busy,
  description,
  enabled,
  onAction,
  running,
  title
}: {
  busy: boolean;
  description: string;
  enabled: boolean;
  onAction: (action: "start" | "stop" | "restart") => void;
  running: boolean;
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Badge tone={running ? "green" : enabled ? "amber" : "neutral"}>
            {running ? "运行中" : enabled ? "已停止" : "未启用"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap justify-end gap-2">
        <Button disabled={busy || running || !enabled} onClick={() => onAction("start")} variant="outline">启动</Button>
        <Button disabled={busy || !running} onClick={() => onAction("stop")} variant="outline">停止</Button>
        <Button disabled={busy || !enabled} onClick={() => onAction("restart")}>重启</Button>
      </CardContent>
    </Card>
  );
}
