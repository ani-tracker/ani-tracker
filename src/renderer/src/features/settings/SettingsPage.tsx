import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { FileSearch, FolderCog, HardDrive, Languages, Monitor, PlayCircle, Power, RotateCcw, Save } from "lucide-react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
import { useAsyncData } from "@/lib/use-async-data";
import type { AutomationSchedulerStatus, QbittorrentManagedStatus } from "@shared/contracts";
import type { AppSettings } from "@shared/domain";

export function SettingsPage() {
  const { data, loading } = useAsyncData(appApi.getSettings, []);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [resetState, setResetState] = useState<"idle" | "resetting" | "reset">("idle");
  const [schedulerStatus, setSchedulerStatus] = useState<AutomationSchedulerStatus | null>(null);
  const [qbManagedStatus, setQbManagedStatus] = useState<QbittorrentManagedStatus | null>(null);
  const [qbManagedAction, setQbManagedAction] = useState<"idle" | "starting" | "stopping">("idle");
  const [qbTest, setQbTest] = useState<{ state: "idle" | "testing" | "success" | "error"; message?: string }>({
    state: "idle"
  });

  useEffect(() => {
    if (data) {
      setDraft(data);
    }
  }, [data]);

  useEffect(() => {
    void refreshSchedulerStatus();
    void refreshQbittorrentManagedStatus();
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

  if (loading) {
    return <div className="text-sm text-muted-foreground">正在加载设置...</div>;
  }

  if (!data || !draft) {
    return <div className="text-sm text-rose-600">设置加载失败。</div>;
  }

  async function saveSettings() {
    if (!draft) {
      return;
    }

    setSaveState("saving");
    const saved = await appApi.updateSettings(draft);
    setDraft(saved);
    await refreshSchedulerStatus();
    await refreshQbittorrentManagedStatus();
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1200);
  }

  async function resetSettingsToDefaults() {
    const confirmed = window.confirm("确认恢复平台默认配置模板？当前设置会被覆盖。");
    if (!confirmed) {
      return;
    }

    setResetState("resetting");
    const saved = await appApi.resetSettingsToDefaults();
    setDraft(saved);
    setQbTest({ state: "idle" });
    await refreshSchedulerStatus();
    await refreshQbittorrentManagedStatus();
    setResetState("reset");
    window.setTimeout(() => setResetState("idle"), 1200);
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">目录、下载引擎、播放器和提醒规则集中管理。</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => void resetSettingsToDefaults()}
            disabled={resetState === "resetting" || saveState === "saving"}
          >
            <RotateCcw className="h-4 w-4" />
            {resetState === "resetting" ? "恢复中" : resetState === "reset" ? "已恢复" : "恢复默认"}
          </Button>
          <Button onClick={saveSettings} disabled={saveState === "saving" || resetState === "resetting"}>
            <Save className="h-4 w-4" />
            {saveState === "saving" ? "保存中" : saveState === "saved" ? "已保存" : "保存"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <Panel title="下载目录" description="支持全局默认目录，后续单部番可以覆盖。">
          <div className="space-y-4">
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
              label="番剧目录模板"
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
        </Panel>

        <Panel title="用户数据" description="数据库、缓存、日志和备份都应随用户数据目录迁移。">
          <div className="space-y-4">
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
        </Panel>
      </div>

      <Panel title="语言与标题" description="界面语言保持固定，番剧元数据按当前标题策略展示和检索。">
        <div className="grid grid-cols-3 gap-4">
          <SettingRow icon={<Languages className="h-4 w-4" />} label="界面语言" value="简体中文" />
          <SettingRow label="标题显示" value="中文优先，副标题显示原名" />
          <SettingRow label="搜索名称" value="标题、原名、罗马音、英文名和自定义别名" />
        </div>
      </Panel>

      <Panel title="桌面集成" description="控制后台运行、系统登录启动等本地桌面行为。">
        <div className="grid grid-cols-2 gap-4">
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
      </Panel>

      <Panel title="播放器配置">
        <div className="grid grid-cols-2 gap-4">
          {draft.players.map((player) => (
            <div key={player.id} className="rounded-md border p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <PlayCircle className="h-4 w-4 text-primary" />
                    {player.name}
                  </div>
                  <div className="mt-2 text-sm text-muted-foreground">{player.executablePath}</div>
                </div>
                <Badge tone={player.id === draft.defaultPlayerProfileId ? "green" : "neutral"}>
                  {player.id === draft.defaultPlayerProfileId ? "默认" : player.platform}
                </Badge>
              </div>
              <div className="mt-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                {player.argumentTemplate}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="媒体探测" description="用于读取已下载视频的编码、分辨率、音轨和字幕轨。">
        <div className="grid grid-cols-[minmax(0,1fr)_180px] gap-4">
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
      </Panel>

      <Panel title="下载核心配置">
        <div className="space-y-4">
          <div className="space-y-4 rounded-md border p-4">
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
            <div className="grid grid-cols-2 gap-3">
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
                      <div className="mt-2 text-xs text-rose-600">{qbManagedStatus.lastError}</div>
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
                      ? "text-sm text-rose-600"
                      : qbTest.state === "success"
                        ? "text-sm text-emerald-700"
                        : "text-sm text-muted-foreground"
                  }
                >
                  {qbTest.message}
                </span>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="自动化">
        <div className="grid grid-cols-5 gap-4">
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
        <div className="mt-4 grid grid-cols-4 gap-3 text-sm">
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
      </Panel>
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
  return (
    <label className="block">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        {icon && <span className="text-primary">{icon}</span>}
        {label}
      </div>
      <input
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ToggleSetting({
  icon,
  label,
  description,
  checked,
  onChange
}: {
  icon?: ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-[104px] items-center justify-between gap-4 rounded-md border p-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon && <span className="text-primary">{icon}</span>}
          {label}
        </div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <input
        className="h-5 w-5 shrink-0 accent-primary"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function NumberSetting({
  label,
  value,
  suffix,
  min = 0,
  onChange
}: {
  label: string;
  value: number;
  suffix?: string;
  min?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block rounded-md border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <input
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
          min={min}
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </label>
  );
}

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
  return (
    <label className="block rounded-md border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <select
        className="mt-2 h-9 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

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
