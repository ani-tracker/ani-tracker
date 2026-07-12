import { PlugZap, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { appApi } from "@/lib/api";
import { useAsyncData } from "@/lib/use-async-data";
import type { ReleaseSourceConfig, SourceKind } from "@shared/domain";

const kindText = {
  rss: "RSS",
  torznab: "Torznab",
  site_adapter: "站点适配器",
  manual: "手动添加"
};

export function SourcesPage() {
  const { data, loading } = useAsyncData(appApi.listSources, []);
  const [sources, setSources] = useState<ReleaseSourceConfig[]>([]);
  const [draft, setDraft] = useState({
    name: "",
    kind: "rss" as SourceKind,
    url: "",
    apiKey: ""
  });

  useEffect(() => {
    if (data) {
      setSources(data);
    }
  }, [data]);

  async function toggleSource(source: ReleaseSourceConfig) {
    const updated = await appApi.setSourceEnabled(source.id, !source.enabled);
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
      apiKey: draft.kind === "torznab" ? draft.apiKey.trim() || undefined : undefined,
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

  if (loading) {
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

      <Panel title="添加下载源" description="先支持通用 RSS / Torznab。站点适配器只保存配置，具体解析器后续按站点实现。">
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
            placeholder="API Key"
            disabled={draft.kind !== "torznab"}
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

function createSourceId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${slug || "source"}-${Date.now()}`;
}
