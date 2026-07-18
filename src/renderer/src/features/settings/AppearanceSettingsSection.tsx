import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import {
  Copy,
  Download,
  Monitor,
  Moon,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Sun,
  Trash2,
  Upload
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTheme } from "@/components/theme-provider";
import {
  BUILT_IN_THEME_PACKS,
  DEFAULT_THEME_PACK_ID,
  hexToHslChannels,
  hslChannelsToHex,
  listAvailableThemePacks,
  readableForegroundForHsl,
  resolveThemePack,
  validateThemePack,
  type AppearanceSettings,
  type ResolvedThemeMode,
  type ThemeMode,
  type ThemePackManifest,
  type ThemeTokenName
} from "@shared/theme";

type EditableColorRole = "primary" | "accent" | "background" | "card";

interface AppearanceSettingsSectionProps {
  appearance: AppearanceSettings;
  onChange: (appearance: AppearanceSettings) => void;
}

const modeOptions: Array<{ value: ThemeMode; label: string; icon: typeof Monitor }> = [
  { value: "system", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon }
];

const radiusOptions = ["0px", "4px", "6px", "8px", "10px", "12px"];

/** 管理明暗模式、主题选择和受控用户主题包。 */
export function AppearanceSettingsSection({ appearance, onChange }: AppearanceSettingsSectionProps) {
  const { previewAppearance, clearPreview } = useTheme();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPack, setEditingPack] = useState<ThemePackManifest | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const themePacks = listAvailableThemePacks(appearance);
  const selectedPack = resolveThemePack(appearance);
  const selectedIsCustom = appearance.customThemePacks.some((pack) => pack.id === selectedPack.id);

  useEffect(() => {
    previewAppearance(appearance);
  }, [appearance, previewAppearance]);

  useEffect(() => () => clearPreview(), [clearPreview]);

  useEffect(() => {
    setDeleteArmed(false);
  }, [appearance.themePackId]);

  useEffect(() => {
    if (!deleteArmed) {
      return;
    }
    const timer = window.setTimeout(() => setDeleteArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  /** 更新明暗模式，空值表示用户再次点击当前选项，应保持原值。 */
  function updateThemeMode(value: string) {
    if (!value) {
      return;
    }
    onChange({ ...appearance, themeMode: value as ThemeMode });
  }

  /** 选择主题包并立即在当前页面预览。 */
  function selectThemePack(value: string) {
    if (!value) {
      return;
    }
    onChange({ ...appearance, themePackId: value });
  }

  /** 打开主题编辑器；内置主题先复制为用户主题。 */
  function openEditor(pack: ThemePackManifest, copy: boolean) {
    const cloned = cloneThemePack(pack);
    if (copy) {
      cloned.id = createCustomThemeId();
      cloned.name = `${pack.name} 自定义`;
      cloned.version = "1.0.0";
      cloned.author = "用户";
    }
    setEditingPack(cloned);
    setEditorOpen(true);
  }

  /** 校验并写入编辑后的用户主题，最终持久化仍由设置页保存按钮负责。 */
  function saveEditedTheme() {
    if (!editingPack) {
      return;
    }
    const result = validateThemePack(editingPack);
    if (!result.pack) {
      toast.error(result.errors[0] ?? "主题校验失败");
      return;
    }
    const customThemePacks = appearance.customThemePacks.some((pack) => pack.id === result.pack!.id)
      ? appearance.customThemePacks.map((pack) => pack.id === result.pack!.id ? result.pack! : pack)
      : [...appearance.customThemePacks, result.pack];
    onChange({ ...appearance, themePackId: result.pack.id, customThemePacks });
    setEditorOpen(false);
    setEditingPack(null);
    toast.success("用户主题已更新，请保存设置");
  }

  /** 保留用户主题身份并恢复默认主题的全部视觉令牌。 */
  function resetEditedTheme() {
    if (!editingPack) {
      return;
    }
    const defaults = cloneThemePack(BUILT_IN_THEME_PACKS[0]);
    setEditingPack({
      ...defaults,
      id: editingPack.id,
      name: editingPack.name,
      version: editingPack.version,
      author: editingPack.author,
      description: editingPack.description
    });
    toast.success("主题样式已恢复默认");
  }

  /** 两次点击确认后删除当前用户主题，避免误操作。 */
  function deleteSelectedTheme() {
    if (!selectedIsCustom) {
      return;
    }
    if (!deleteArmed) {
      setDeleteArmed(true);
      toast.warning("再次点击删除按钮以确认");
      return;
    }
    onChange({
      ...appearance,
      themePackId: DEFAULT_THEME_PACK_ID,
      customThemePacks: appearance.customThemePacks.filter((pack) => pack.id !== selectedPack.id)
    });
    setDeleteArmed(false);
    toast.success("用户主题已删除，请保存设置");
  }

  /** 导出当前主题为声明式 JSON 文件。 */
  function exportSelectedTheme() {
    const blob = new Blob([`${JSON.stringify(selectedPack, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedPack.id}.ani-theme.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    toast.success("主题包已导出");
  }

  /** 导入并严格校验主题 JSON，冲突标识会自动复制为新主题。 */
  async function importTheme(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    try {
      if (file.size > 128 * 1024) {
        throw new Error("主题包不能超过 128KB");
      }
      const result = validateThemePack(JSON.parse(await file.text()));
      if (!result.pack) {
        throw new Error(result.errors.slice(0, 2).join("；") || "主题包校验失败");
      }
      let imported = result.pack;
      if (themePacks.some((pack) => pack.id === imported.id)) {
        imported = { ...imported, id: createCustomThemeId(), name: `${imported.name} 导入` };
      }
      onChange({
        ...appearance,
        themePackId: imported.id,
        customThemePacks: [...appearance.customThemePacks, imported]
      });
      toast.success("主题包已导入，请保存设置");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主题包导入失败");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette />
          外观
        </CardTitle>
        <CardDescription>明暗模式与主题包分别管理。</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field orientation="responsive">
            <div className="min-w-36">
              <FieldTitle id="theme-mode-label">明暗模式</FieldTitle>
              <FieldDescription>默认跟随当前操作系统。</FieldDescription>
            </div>
            <ToggleGroup
              aria-labelledby="theme-mode-label"
              className="w-full flex-wrap justify-start sm:w-auto"
              type="single"
              variant="outline"
              value={appearance.themeMode}
              onValueChange={updateThemeMode}
            >
              {modeOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <ToggleGroupItem key={option.value} value={option.value} aria-label={option.label}>
                    <Icon />
                    {option.label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </Field>

          <Field>
            <FieldTitle id="theme-pack-label">主题风格</FieldTitle>
            <ToggleGroup
              aria-labelledby="theme-pack-label"
              className="grid w-full grid-cols-1 items-stretch sm:grid-cols-2 xl:grid-cols-3"
              type="single"
              variant="outline"
              value={appearance.themePackId}
              onValueChange={selectThemePack}
            >
              {themePacks.map((pack) => (
                <ToggleGroupItem
                  key={pack.id}
                  className="h-auto min-h-24 min-w-0 flex-col items-stretch p-3 text-left"
                  value={pack.id}
                  aria-label={`选择${pack.name}主题`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate font-medium">{pack.name}</span>
                    <ThemeSwatches pack={pack} />
                  </div>
                  <span className="line-clamp-2 w-full text-xs font-normal text-muted-foreground">
                    {pack.description ?? "用户主题"}
                  </span>
                  <div className="flex w-full items-center gap-2">
                    <Badge>{appearance.customThemePacks.some((item) => item.id === pack.id) ? "用户" : "内置"}</Badge>
                    <span className="text-xs font-normal text-muted-foreground">v{pack.version}</span>
                  </div>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Input
            ref={fileInputRef}
            id={fileInputId}
            className="hidden"
            type="file"
            accept=".json,.ani-theme.json,application/json"
            onChange={(event) => void importTheme(event)}
          />
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => openEditor(selectedPack, true)}>
          <Plus data-icon="inline-start" />
          复制为自定义
        </Button>
        {selectedIsCustom && (
          <Button variant="outline" onClick={() => openEditor(selectedPack, false)}>
            <Pencil data-icon="inline-start" />
            编辑
          </Button>
        )}
        <Button variant="outline" onClick={() => fileInputRef.current?.click()}>
          <Upload data-icon="inline-start" />
          导入
        </Button>
        <Button variant="outline" onClick={exportSelectedTheme}>
          <Download data-icon="inline-start" />
          导出
        </Button>
        {selectedIsCustom && (
          <Button variant={deleteArmed ? "destructive" : "outline"} onClick={deleteSelectedTheme}>
            <Trash2 data-icon="inline-start" />
            {deleteArmed ? "确认删除" : "删除"}
          </Button>
        )}
      </CardFooter>

      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>编辑用户主题</SheetTitle>
            <SheetDescription>修改开放的语义颜色和全局圆角。</SheetDescription>
          </SheetHeader>
          {editingPack && (
            <FieldGroup className="py-5">
              <Field>
                <FieldLabel htmlFor="theme-pack-name">主题名称</FieldLabel>
                <Input
                  id="theme-pack-name"
                  maxLength={40}
                  value={editingPack.name}
                  onChange={(event) => setEditingPack({ ...editingPack, name: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="theme-pack-radius">全局圆角</FieldLabel>
                <Select
                  value={editingPack.style.radius}
                  onValueChange={(radius) => setEditingPack({ ...editingPack, style: { radius } })}
                >
                  <SelectTrigger id="theme-pack-radius"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {radiusOptions.map((radius) => <SelectItem key={radius} value={radius}>{radius}</SelectItem>)}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <ThemeModeEditor mode="light" pack={editingPack} onChange={setEditingPack} />
              <ThemeModeEditor mode="dark" pack={editingPack} onChange={setEditingPack} />
            </FieldGroup>
          )}
          <SheetFooter>
            <Button variant="outline" onClick={resetEditedTheme}>
              <RotateCcw data-icon="inline-start" />
              恢复默认样式
            </Button>
            <Button variant="outline" onClick={() => setEditorOpen(false)}>取消</Button>
            <Button onClick={saveEditedTheme}>
              <Copy data-icon="inline-start" />
              应用主题
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

function ThemeSwatches({ pack }: { pack: ThemePackManifest }) {
  const tokens = pack.tokens.light;
  return (
    <span className="flex shrink-0 gap-1" aria-hidden="true">
      {[tokens.primary, tokens.accent, tokens.background].map((color, index) => (
        <span
          key={`${color}-${index}`}
          className="size-4 rounded-sm border"
          style={{ backgroundColor: `hsl(${color})` }}
        />
      ))}
    </span>
  );
}

function ThemeModeEditor({
  mode,
  pack,
  onChange
}: {
  mode: ResolvedThemeMode;
  pack: ThemePackManifest;
  onChange: (pack: ThemePackManifest) => void;
}) {
  const label = mode === "light" ? "浅色模式" : "深色模式";
  const defaults = BUILT_IN_THEME_PACKS[0];
  const resetRole = (role: EditableColorRole) => {
    const token = role as Extract<ThemeTokenName, EditableColorRole>;
    onChange(updatePackColor(pack, mode, role, hslChannelsToHex(defaults.tokens[mode][token])));
  };
  return (
    <Field>
      <FieldTitle>{label}</FieldTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <ThemeColorField label="主操作色" value={pack.tokens[mode].primary} onChange={(hex) => onChange(updatePackColor(pack, mode, "primary", hex))} onReset={() => resetRole("primary")} />
        <ThemeColorField label="辅助色" value={pack.tokens[mode].accent} onChange={(hex) => onChange(updatePackColor(pack, mode, "accent", hex))} onReset={() => resetRole("accent")} />
        <ThemeColorField label="页面背景" value={pack.tokens[mode].background} onChange={(hex) => onChange(updatePackColor(pack, mode, "background", hex))} onReset={() => resetRole("background")} />
        <ThemeColorField label="内容表面" value={pack.tokens[mode].card} onChange={(hex) => onChange(updatePackColor(pack, mode, "card", hex))} onReset={() => resetRole("card")} />
      </div>
    </Field>
  );
}

function ThemeColorField({
  label,
  value,
  onChange,
  onReset
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  const inputId = useId();
  const hex = hslChannelsToHex(value);
  return (
    <Field orientation="horizontal" className="rounded-md border p-3">
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div className="flex shrink-0 items-center gap-1">
        <Input
          id={inputId}
          aria-label={`${label}颜色`}
          className="size-11 shrink-0 cursor-pointer p-1 md:size-9"
          type="color"
          value={hex}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button type="button" variant="ghost" className="size-11 p-0 md:size-9" aria-label={`重置${label}`} title={`重置${label}`} onClick={onReset}>
          <RotateCcw />
        </Button>
      </div>
    </Field>
  );
}

function updatePackColor(
  pack: ThemePackManifest,
  mode: ResolvedThemeMode,
  role: EditableColorRole,
  hex: string
): ThemePackManifest {
  const value = hexToHslChannels(hex);
  const foreground = readableForegroundForHsl(value);
  const tokens = { ...pack.tokens[mode] };
  const setToken = (name: ThemeTokenName, next: string) => { tokens[name] = next; };

  if (role === "primary") {
    for (const token of ["primary", "ring", "chart-1", "sidebar-primary", "sidebar-ring"] as ThemeTokenName[]) {
      setToken(token, value);
    }
    setToken("primary-foreground", foreground);
    setToken("sidebar-primary-foreground", foreground);
  } else if (role === "accent") {
    setToken("accent", value);
    setToken("accent-foreground", foreground);
    setToken("sidebar-accent", value);
    setToken("sidebar-accent-foreground", foreground);
  } else if (role === "background") {
    setToken("background", value);
    setToken("foreground", foreground);
  } else {
    setToken("card", value);
    setToken("card-foreground", foreground);
    setToken("popover", value);
    setToken("popover-foreground", foreground);
  }

  return {
    ...pack,
    tokens: {
      ...pack.tokens,
      [mode]: tokens
    }
  };
}

function cloneThemePack(pack: ThemePackManifest): ThemePackManifest {
  return JSON.parse(JSON.stringify(pack)) as ThemePackManifest;
}

function createCustomThemeId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
