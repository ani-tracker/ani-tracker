import { KeyRound, Network, Pencil, PlugZap, Plus, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  const { data, loading } = useAsyncData(appApi.listSources, []);
  const { data: settingsData, loading: settingsLoading } = useAsyncData(appApi.getSettings, []);
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
    return <div className="text-sm text-muted-foreground">正在加载下载源...</div>;
  }

  return (
    <div className="space-y-5">
      <div>
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">下载源</h1>
          <p className="mt-1 text-sm text-muted-foreground">RSS、Torznab 和站点适配器会输出统一资源结构。</p>
        </div>
      </div>

      <Panel title="元数据代理" description="仅用于新番发现中的 AniList、Bangumi 和 Mikan 元数据采集。">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-4">
            <ProxySummaryItem
              icon={<Network className="h-4 w-4" />}
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
          <Button variant="outline" onClick={startEditProxy} disabled={!settings || proxySaveState === "saving"}>
            <Pencil className="h-4 w-4" />
            编辑
          </Button>
        </div>

        {proxyEditing ? (
          <div className="mt-4 rounded-md border p-4">
            <div className="grid grid-cols-[180px_minmax(0,1fr)_140px] gap-3">
              <label className="block">
                <div className="mb-2 text-sm font-medium">模式</div>
                <select
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
                  value={proxyDraft.mode}
                  onChange={(event) =>
                    setProxyDraft({
                      ...proxyDraft,
                      mode: event.target.value as MetadataProxySettings["mode"]
                    })
                  }
                >
                  <option value="off">关闭</option>
                  <option value="system">系统代理</option>
                  <option value="manual">手动代理</option>
                </select>
              </label>
              <label className="block">
                <div className="mb-2 text-sm font-medium">代理地址</div>
                <input
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
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
              </label>
              <label className="block">
                <div className="mb-2 text-sm font-medium">超时秒数</div>
                <input
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
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
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button onClick={() => void saveMetadataProxy()} disabled={proxySaveState === "saving"}>
                <Save className="h-4 w-4" />
                {proxySaveState === "saving" ? "保存中" : proxySaveState === "saved" ? "已保存" : "保存"}
              </Button>
              <Button variant="outline" onClick={() => setProxyEditing(false)} disabled={proxySaveState === "saving"}>
                <X className="h-4 w-4" />
                取消
              </Button>
              {proxyError && <span className="text-sm text-rose-600">{proxyError}</span>}
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel title="添加下载源" description="支持通用 RSS / Torznab；站点适配器已内置动漫花园、蜜柑计划、AniBT 和 ACGNX 解析。">
        <div className="grid grid-cols-[1fr_160px_1.4fr_1fr_auto] gap-3">
          <input
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            placeholder="名称"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            value={draft.kind}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as SourceKind })}
          >
            <option value="rss">RSS</option>
            <option value="torznab">Torznab</option>
            <option value="site_adapter">站点适配器</option>
          </select>
          <input
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            placeholder={draft.kind === "rss" ? "RSS 地址" : "服务地址"}
            value={draft.url}
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          />
          <input
            className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary"
            placeholder={draft.kind === "site_adapter" ? "Token / Cookie" : "API Key"}
            disabled={draft.kind === "rss"}
            value={draft.apiKey}
            onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
          />
          <Button onClick={addSource}>
            <Plus className="h-4 w-4" />
            保存
          </Button>
        </div>
      </Panel>

      <div className="grid grid-cols-3 gap-4">
        {sources.map((source) => (
          <Panel key={source.id}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 font-medium">
                  <PlugZap className="h-4 w-4 text-primary" />
                  {source.name}
                </div>
                <div className="mt-2 text-sm text-muted-foreground">{source.baseUrl ?? source.rssUrl ?? "本地输入"}</div>
              </div>
              <Badge tone={source.enabled ? "green" : "neutral"}>{source.enabled ? "启用" : "停用"}</Badge>
            </div>
            <div className="mt-4 flex gap-2">
              <Badge tone="blue">{kindText[source.kind]}</Badge>
              {source.tags?.map((tag) => <Badge key={tag}>{tag}</Badge>)}
            </div>
            {canUseCredential(source) ? (
              <div className="mt-4 flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
                    placeholder={source.kind === "site_adapter" ? "Token / Cookie" : "API Key"}
                    type="password"
                    value={credentials[source.id] ?? ""}
                    onChange={(event) => setCredentials({ ...credentials, [source.id]: event.target.value })}
                  />
                </div>
                <Button variant="outline" onClick={() => saveCredential(source)}>
                  <Save className="h-4 w-4" />
                  保存
                </Button>
              </div>
            ) : null}
            <div className="mt-4">
              <Button variant="outline" onClick={() => toggleSource(source)}>
                {source.enabled ? "停用" : "启用"}
              </Button>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function canUseCredential(source: ReleaseSourceConfig): boolean {
  return source.kind === "torznab" || source.kind === "site_adapter";
}

const defaultMetadataProxySettings: MetadataProxySettings = {
  mode: "off",
  timeoutMs: 5_000
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
    <div className="min-w-0 rounded-md border p-3">
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
