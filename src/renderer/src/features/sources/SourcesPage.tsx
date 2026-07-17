import { KeyRound, Network, Pencil, PlugZap, Plus, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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

const kindText = {
  rss: "RSS",
  torznab: "Torznab",
  site_adapter: "站点适配器",
  manual: "手动添加"
};

export function SourcesPage() {
  const { data, error: sourcesError, loading } = useAsyncData(appApi.listSources, []);
  const { data: settingsData, error: settingsError, loading: settingsLoading } = useAsyncData(appApi.getSettings, []);
  const [sources, setSources] = useState<ReleaseSourceConfig[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
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
    }
  }, [data]);

  useEffect(() => {
    if (settingsData) {
      setSettings(settingsData);
      setProxyDraft(getMetadataProxySettings(settingsData));
    }
  }, [settingsData]);

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

  if (loading || settingsLoading) {
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

  const loadingError = sourcesError ?? settingsError;
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
            <CardDescription>仅用于新番发现中的 AniList、Bangumi 和 Mikan 元数据采集。</CardDescription>
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
                {source.tags?.map((tag) => <Badge key={tag}>{tag}</Badge>)}
              </div>
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
