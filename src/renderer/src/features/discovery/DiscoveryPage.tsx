import { CalendarPlus, Search } from "lucide-react";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const discoveryItems = [
  {
    id: "d1",
    title: "上月新番采集",
    description: "从 Bangumi / AniList / 蜜柑季度表汇总，按首播年月写入本地番剧库。",
    status: "待接入"
  },
  {
    id: "d2",
    title: "别名搜索",
    description: "中文名、日文原名、罗马音、英文名会一起参与资源搜索。",
    status: "已设计"
  },
  {
    id: "d3",
    title: "季度归档",
    description: "新番发现页按年月和季度过滤，添加后进入我的追番。",
    status: "已设计"
  }
];

export function DiscoveryPage() {
  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">新番发现</h1>
          <p className="mt-1 text-sm text-muted-foreground">后续会接入番剧元数据源，这里先固定交互结构。</p>
        </div>
        <Button>
          <CalendarPlus className="h-4 w-4" />
          采集上月新番
        </Button>
      </div>

      <Panel>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
              placeholder="搜索中文名、日文名、罗马音或英文名"
            />
          </div>
          <select className="h-10 rounded-md border bg-background px-3 text-sm outline-none focus:border-primary">
            <option>2026 年 7 月</option>
            <option>2026 年 6 月</option>
            <option>2026 年 4 月</option>
          </select>
        </div>
      </Panel>

      <div className="grid grid-cols-3 gap-4">
        {discoveryItems.map((item) => (
          <Panel key={item.id}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="font-medium">{item.title}</div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
              </div>
              <Badge tone={item.status === "已设计" ? "green" : "amber"}>{item.status}</Badge>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
