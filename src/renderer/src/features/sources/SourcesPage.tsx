import { KeyRound, Network, Pencil, PlugZap, Plus, RefreshCw, Save, Timer, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { appApi } from "@/lib/api";
import { useAsyncData } from "@/lib/use-async-data";
import type { AppSettings, MetadataProxySettings, ReleaseSourceConfig, SourceKind } from "@shared/domain";
import type { SourceSyncSchedulerStatus } from "@shared/contracts";

const kindText = {
  rss: "RSS",
  torznab: "Torznab",
  site_adapter: "站点适配器",
  manual: "手动添加"
};

export function SourcesPage() {
  const { data, error: sourcesError, loading } = useAsyncData(appApi.listSources, []);
  const { data: settingsData, error: settingsError, loading: settingsLoading } = useAsyncData(appApi.getSettings, []);
  const { data: syncStatusData, error: syncStatusError, loading: syncStatusLoading } = useAsyncData(appApi.getSourceSyncStatus, []);
  const [sources, setSources] = useState<ReleaseSourceConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  const [syncStatus, setSyncStatus] = useState<SourceSyncSchedulerStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncTimeDraft, setSyncTimeDraft] = useState("09:00");
  const [proxyEditing, setProxyEditing] = useState(false);
  const [proxyDraft, setProxyDraft] = useState<MetadataProxySettings>(defaultMetadataProxySettings);
  const [proxySaveState, setProxySaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    name: "",
    kind: "rss" as SourceKind,
    url: "",
    apiKey: ""
  });

  useEffect(() => {
    if (data) {
      setSources(data);
      setCredentials(Object.fromEntries(data.map((source) => [source.id, source.apiKey ?? ""])));
      setIntervalDrafts(Object.fromEntries(data.map((source) => [
        source.id,
        String(normalizeSourceInterval(source.requestIntervalMs))
      ])));
    }
  }, [data]);

  useEffect(() => {
    if (settingsData) {
      setSettings(settingsData);
      setProxyDraft(getMetadataProxySettings(settingsData));
      setSyncTimeDraft(getSourceSyncSettings(settingsData).dailyTime);
    }
  }, [settingsData]);

  useEffect(() => {
    if (syncStatusData) {
      setSyncStatus(syncStatusData);
    }
  }, [syncStatusData]);

  async function toggleSource(source: ReleaseSourceConfig) {
    const updated = await appApi.setSourceEnabled(source.id, !source.enabled);
    setSources(updated);
  }

  async function saveCredential(source: ReleaseSourceConfig) {
    const updated = await appApi.upsertSource({
      ...source,
      apiKey: credentials[source.id]?.trim() || undefined
    });
    setSources(updated);
  }

  async function toggleSourceProxy(source: ReleaseSourceConfig) {
    const updated = await appApi.upsertSource({
      ...source,
      useProxy: !(source.useProxy ?? false),
      requestIntervalMs: normalizeSourceInterval(source.requestIntervalMs)
    });
    setSources(updated);
  }

  async function saveSourceInterval(source: ReleaseSourceConfig) {
    const requestIntervalMs = normalizeSourceInterval(Number(intervalDrafts[source.id]));
    const updated = await appApi.upsertSource({ ...source, requestIntervalMs });
    setSources(updated);
    setIntervalDrafts((current) => ({ ...current, [source.id]: String(requestIntervalMs) }));
    toast.success("采集策略已保存");
  }

  async function addSource() {
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) {
      return;
    }

    const source: ReleaseSourceConfig = {
      id: createSourceId(name),
      name,
      kind: draft.kind,
      enabled: true,
      useProxy: false,
      requestIntervalMs: 1_500,
      rssUrl: draft.kind === "rss" ? url : undefined,
      baseUrl: draft.kind !== "rss" ? url : undefined,
      apiKey: draft.kind !== "rss" ? draft.apiKey.trim() || undefined : undefined,
      tags: [draft.kind]
    };

    setSources(await appApi.upsertSource(source));
    setDraft({
      name: "",
      kind: "rss",
      url: "",
      apiKey: ""
    });
  }

  function startEditProxy() {
    if (!settings) {
      return;
    }

    setProxyDraft(getMetadataProxySettings(settings));
    setProxyError(null);
    setProxyEditing(true);
  }

  async function saveMetadataProxy() {
    if (!settings) {
      return;
    }

    const nextProxy = normalizeMetadataProxyDraft(proxyDraft);
    if (nextProxy.mode === "manual" && !nextProxy.url) {
      setProxyError("请输入手动代理地址");
      return;
    }

    setProxySaveState("saving");
    setProxyError(null);
    const saved = await appApi.updateSettings({
      network: {
        ...settings.network,
        metadataProxy: nextProxy
      }
    });
    setSettings(saved);
    setProxyDraft(getMetadataProxySettings(saved));
    setProxyEditing(false);
    setProxySaveState("saved");
    window.setTimeout(() => setProxySaveState("idle"), 1200);
  }

  async function updateSourceSyncSettings(patch: { enabled?: boolean; dailyTime?: string }) {
    if (!settings) {
      return;
    }
    const current = getSourceSyncSettings(settings);
    const saved = await appApi.updateSettings({
      sourceSync: {
        enabled: patch.enabled ?? current.enabled,
        dailyTime: patch.dailyTime ?? current.dailyTime
      }
    });
    setSettings(saved);
    setSyncTimeDraft(getSourceSyncSettings(saved).dailyTime);
    setSyncStatus(await appApi.getSourceSyncStatus());
  }

  async function syncSourcesNow() {
    setSyncing(true);
    try {
      const result = await appApi.syncSourcesNow();
      setSyncStatus(await appApi.getSourceSyncStatus());
      if (result.errors.length) {
        toast.warning(`同步完成，${result.errors.length} 个来源失败`);
      } else {
        toast.success(`同步完成，新增 ${result.addedReleaseCount} 条资源`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载源同步失败");
    } finally {
      setSyncing(false);
    }
  }

  if (loading || settingsLoading || syncStatusLoading) {
    return (
      <div className="flex flex-col gap-5" aria-label="正在加载下载源">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-56 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="hidden h-64 w-full md:block" />
          <Skeleton className="hidden h-64 w-full xl:block" />
        </div>
      </div>
    );
  }

  const loadingError = sourcesError ?? settingsError ?? syncStatusError;
  if (loadingError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>下载源加载失败</AlertTitle>
        <AlertDescription>{loadingError.message || "请重新进入下载源页面或重启应用后再试。"}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-normal">下载源</h1>
        <p className="mt-1 text-sm text-muted-foreground">RSS、Torznab 和站点适配器会输出统一资源结构。</p>
      </div>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>元数据代理</CardTitle>
            <CardDescription>用于元数据采集，以及已开启“使用全局代理”的下载源请求。</CardDescription>
          </div>
          <Button className="w-full sm:w-auto" variant="outline" onClick={startEditProxy} disabled={!settings || proxySaveState === "saving"}>
            <Pencil data-icon="inline-start" />
            编辑
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            <ProxySummaryItem
              icon={<Network className="size-4" />}
              label="代理模式"
              value={formatProxyMode(getMetadataProxySettings(settings).mode)}
            />
            <ProxySummaryItem
              label="代理地址"
              value={getMetadataProxySettings(settings).mode === "manual" ? getMetadataProxySettings(settings).url || "--" : "--"}
            />
            <ProxySummaryItem
              label="请求超时"
              value={`${Math.round(getMetadataProxySettings(settings).timeoutMs / 1000)} 秒`}
            />
          </div>

          {proxyEditing ? (
            <>
              <Separator className="my-5" />
              <FieldGroup className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[180px_minmax(0,1fr)_140px]">
                <Field>
                  <FieldLabel htmlFor="metadata-proxy-mode">模式</FieldLabel>
                  <Select
                    value={proxyDraft.mode}
                    onValueChange={(value) =>
                      setProxyDraft({
                        ...proxyDraft,
                        mode: value as MetadataProxySettings["mode"]
                      })
                    }
                  >
                    <SelectTrigger id="metadata-proxy-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="off">关闭</SelectItem>
                        <SelectItem value="system">系统代理</SelectItem>
                        <SelectItem value="manual">手动代理</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field data-disabled={proxyDraft.mode !== "manual"}>
                  <FieldLabel htmlFor="metadata-proxy-url">代理地址</FieldLabel>
                  <Input
                    id="metadata-proxy-url"
                    disabled={proxyDraft.mode !== "manual"}
                    placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7890"
                    value={proxyDraft.url ?? ""}
                    onChange={(event) =>
                      setProxyDraft({
                        ...proxyDraft,
                        url: event.target.value
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="metadata-proxy-timeout">超时秒数</FieldLabel>
                  <Input
                    id="metadata-proxy-timeout"
                    min={1}
                    type="number"
                    value={Math.round(proxyDraft.timeoutMs / 1000)}
                    onChange={(event) =>
                      setProxyDraft({
                        ...proxyDraft,
                        timeoutMs: Number(event.target.value) * 1000
                      })
                    }
                  />
                </Field>
              </FieldGroup>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button onClick={() => void saveMetadataProxy()} disabled={proxySaveState === "saving"}>
                  <Save data-icon="inline-start" />
                  {proxySaveState === "saving" ? "保存中" : proxySaveState === "saved" ? "已保存" : "保存"}
                </Button>
                <Button variant="outline" onClick={() => setProxyEditing(false)} disabled={proxySaveState === "saving"}>
                  <X data-icon="inline-start" />
                  取消
                </Button>
              </div>
              {proxyError && (
                <Alert className="mt-4" variant="destructive">
                  <AlertTitle>代理设置无效</AlertTitle>
                  <AlertDescription>{proxyError}</AlertDescription>
                </Alert>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <CardTitle>每日增量同步</CardTitle>
            <CardDescription>按来源保存同步状态；当天未成功时会在应用启动后自动补跑。</CardDescription>
          </div>
          <Button
            className="w-full sm:w-auto"
            variant="outline"
            disabled={syncing || syncStatus?.inFlight}
            onClick={() => void syncSourcesNow()}
          >
            <RefreshCw data-icon="inline-start" />
            {syncing || syncStatus?.inFlight ? "同步中" : "立即同步"}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Field className="justify-between" orientation="horizontal">
              <FieldLabel htmlFor="source-sync-enabled">启用每日同步</FieldLabel>
              <Switch
                id="source-sync-enabled"
                checked={getSourceSyncSettings(settings).enabled}
                onCheckedChange={(enabled) => void updateSourceSyncSettings({ enabled })}
              />
            </Field>
            <Field data-disabled={!getSourceSyncSettings(settings).enabled}>
              <FieldLabel htmlFor="source-sync-time">每日同步时间</FieldLabel>
              <div className="flex min-w-0 gap-2">
                <Input
                  id="source-sync-time"
                  type="time"
                  disabled={!getSourceSyncSettings(settings).enabled}
                  value={syncTimeDraft}
                  onChange={(event) => setSyncTimeDraft(event.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!getSourceSyncSettings(settings).enabled}
                  onClick={() => void updateSourceSyncSettings({ dailyTime: syncTimeDraft })}
                >
                  <Save data-icon="inline-start" />
                  保存
                </Button>
              </div>
            </Field>
          </FieldGroup>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            <ProxySummaryItem icon={<Timer className="size-4" />} label="计划时间" value={getSourceSyncSettings(settings).dailyTime} />
            <ProxySummaryItem label="上次完成" value={formatOptionalDateTime(syncStatus?.lastRunAt)} />
            <ProxySummaryItem label="下次同步" value={formatOptionalDateTime(syncStatus?.nextRunAt)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>添加下载源</CardTitle>
          <CardDescription>支持通用 RSS / Torznab；站点适配器已内置动漫花园、蜜柑计划、AniBT 和 ACGNX 解析。</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void addSource();
            }}
          >
            <FieldGroup className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_160px_1.4fr_1fr_auto] xl:items-end">
              <Field>
                <FieldLabel htmlFor="source-name">名称</FieldLabel>
                <Input
                  id="source-name"
                  placeholder="名称"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="source-kind">类型</FieldLabel>
                <Select value={draft.kind} onValueChange={(value) => setDraft({ ...draft, kind: value as SourceKind })}>
                  <SelectTrigger id="source-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="rss">RSS</SelectItem>
                      <SelectItem value="torznab">Torznab</SelectItem>
                      <SelectItem value="site_adapter">站点适配器</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="source-url">服务地址</FieldLabel>
                <Input
                  id="source-url"
                  placeholder={draft.kind === "rss" ? "RSS 地址" : "服务地址"}
                  value={draft.url}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                />
              </Field>
              <Field data-disabled={draft.kind === "rss"}>
                <FieldLabel htmlFor="source-api-key">访问凭据</FieldLabel>
                <Input
                  id="source-api-key"
                  placeholder={draft.kind === "site_adapter" ? "Token / Cookie" : "API Key"}
                  disabled={draft.kind === "rss"}
                  value={draft.apiKey}
                  onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                />
              </Field>
              <Field className="sm:col-span-2 xl:col-span-1">
                <FieldLabel className="sr-only" htmlFor="save-source">保存下载源</FieldLabel>
                <Button id="save-source" className="w-full xl:w-auto" type="submit">
                  <Plus data-icon="inline-start" />
                  保存
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sources.map((source) => (
          <Card key={source.id} className="min-w-0">
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <PlugZap className="size-4 shrink-0 text-primary" />
                  <span className="truncate">{source.name}</span>
                </CardTitle>
                <Badge tone={source.enabled ? "green" : "neutral"}>{source.enabled ? "启用" : "停用"}</Badge>
              </div>
              <CardDescription className="break-all">{source.baseUrl ?? source.rssUrl ?? "本地输入"}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                <Badge tone="blue">{kindText[source.kind]}</Badge>
                <Badge tone={source.useProxy && getMetadataProxySettings(settings).mode === "off" ? "amber" : "neutral"}>
                  {source.useProxy
                    ? getMetadataProxySettings(settings).mode === "off" ? "代理待配置" : "使用代理"
                    : "直连"}
                </Badge>
                <Badge>{normalizeSourceInterval(source.requestIntervalMs)}ms</Badge>
                {source.tags?.map((tag) => <Badge key={tag}>{tag}</Badge>)}
              </div>
              <FieldGroup className="gap-3">
                <Field className="justify-between" orientation="horizontal">
                  <FieldLabel htmlFor={`source-proxy-${source.id}`}>使用全局代理</FieldLabel>
                  <Switch
                    id={`source-proxy-${source.id}`}
                    checked={source.useProxy ?? false}
                    onCheckedChange={() => void toggleSourceProxy(source)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`source-interval-${source.id}`}>最小采集间隔（毫秒）</FieldLabel>
                  <div className="flex min-w-0 gap-2">
                    <Input
                      id={`source-interval-${source.id}`}
                      type="number"
                      min={250}
                      max={60000}
                      step={250}
                      value={intervalDrafts[source.id] ?? "1500"}
                      onChange={(event) => setIntervalDrafts({ ...intervalDrafts, [source.id]: event.target.value })}
                    />
                    <Button variant="outline" onClick={() => void saveSourceInterval(source)}>
                      <Save data-icon="inline-start" />
                      保存
                    </Button>
                  </div>
                </Field>
              </FieldGroup>
              {canUseCredential(source) ? (
                <FieldGroup className="gap-3 xl:flex-row xl:items-end">
                  <Field className="min-w-0 flex-1">
                    <FieldLabel htmlFor={`source-credential-${source.id}`}>
                      <KeyRound className="size-4" />
                      访问凭据
                    </FieldLabel>
                    <Input
                      id={`source-credential-${source.id}`}
                      placeholder={source.kind === "site_adapter" ? "Token / Cookie" : "API Key"}
                      type="password"
                      value={credentials[source.id] ?? ""}
                      onChange={(event) => setCredentials({ ...credentials, [source.id]: event.target.value })}
                    />
                  </Field>
                  <Field className="xl:w-auto">
                    <FieldLabel className="sr-only" htmlFor={`save-source-credential-${source.id}`}>保存访问凭据</FieldLabel>
                    <Button
                      id={`save-source-credential-${source.id}`}
                      className="w-full xl:w-auto"
                      variant="outline"
                      onClick={() => void saveCredential(source)}
                    >
                      <Save data-icon="inline-start" />
                      保存
                    </Button>
                  </Field>
                </FieldGroup>
              ) : null}
            </CardContent>
            <CardFooter>
              <Field className="justify-between" orientation="horizontal">
                <FieldLabel htmlFor={`source-enabled-${source.id}`}>启用下载源</FieldLabel>
                <Switch
                  id={`source-enabled-${source.id}`}
                  checked={source.enabled}
                  onCheckedChange={() => void toggleSource(source)}
                />
              </Field>
            </CardFooter>
          </Card>
        ))}
        {sources.length === 0 && (
          <Empty className="md:col-span-2 xl:col-span-3">
            <EmptyHeader>
              <EmptyMedia variant="icon"><PlugZap /></EmptyMedia>
              <EmptyTitle>暂无下载源</EmptyTitle>
              <EmptyDescription>添加 RSS、Torznab 或站点适配器后会显示在这里。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

function canUseCredential(source: ReleaseSourceConfig): boolean {
  return source.kind === "torznab" || source.kind === "site_adapter";
}

const defaultMetadataProxySettings: MetadataProxySettings = {
  mode: "off",
  timeoutMs: 15_000
};

function getMetadataProxySettings(settings: AppSettings | null): MetadataProxySettings {
  return settings?.network?.metadataProxy ?? defaultMetadataProxySettings;
}

function getSourceSyncSettings(settings: AppSettings | null): { enabled: boolean; dailyTime: string } {
  const dailyTime = settings?.sourceSync?.dailyTime;
  return {
    enabled: settings?.sourceSync?.enabled ?? true,
    dailyTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime ?? "") ? dailyTime! : "09:00"
  };
}

function normalizeSourceInterval(value?: number): number {
  if (!Number.isFinite(value)) {
    return 1_500;
  }
  return Math.max(250, Math.min(60_000, Math.round(value!)));
}

function formatOptionalDateTime(value?: string): string {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--" : date.toLocaleString();
}

function normalizeMetadataProxyDraft(draft: MetadataProxySettings): MetadataProxySettings {
  const timeoutMs = Number.isFinite(draft.timeoutMs) ? Math.round(draft.timeoutMs) : defaultMetadataProxySettings.timeoutMs;

  return {
    mode: draft.mode,
    url: draft.mode === "manual" ? draft.url?.trim() || undefined : undefined,
    timeoutMs: Math.max(1_000, Math.min(60_000, timeoutMs))
  };
}

function formatProxyMode(mode: MetadataProxySettings["mode"]): string {
  if (mode === "system") {
    return "系统代理";
  }

  if (mode === "manual") {
    return "手动代理";
  }

  return "关闭";
}

function ProxySummaryItem({
  icon,
  label,
  value
}: {
  icon?: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted p-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon && <span className="text-primary">{icon}</span>}
        {label}
      </div>
      <div className="mt-2 break-all text-sm font-medium">{value}</div>
    </div>
  );
}

function createSourceId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${slug || "source"}-${Date.now()}`;
}
