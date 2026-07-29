import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import {
  Copy,
  Download,
  Image as ImageIcon,
  ImageOff,
  LoaderCircle,
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
import { toast } from "@/lib/toast";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { WorkbenchSheet } from "@/components/workbench-sheet";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTheme } from "@/components/theme-provider";
import { appApi } from "@/lib/api";
import {
  attachThemeBackground,
  createThemeExport,
  normalizeThemeBackgroundFile,
  readThemeImport,
  sampleThemeBackgroundUrl,
  validateThemeBackgroundContrast
} from "@/lib/theme-package";
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
  const { backgroundState, resolvedTheme, previewAppearance, clearPreview } = useTheme();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputId = useId();
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPack, setEditingPack] = useState<ThemePackManifest | null>(null);
  const [editorBackgroundUrl, setEditorBackgroundUrl] = useState<string>();
  const [editorBackgroundSamples, setEditorBackgroundSamples] = useState<Uint8ClampedArray>();
  const [editorBackgroundState, setEditorBackgroundState] = useState<"none" | "loading" | "ready" | "missing" | "error">("none");
  const [packageAction, setPackageAction] = useState<"idle" | "copying" | "importing" | "exporting">("idle");
  const [backgroundAction, setBackgroundAction] = useState<"idle" | "uploading" | "validating">("idle");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const themePacks = listAvailableThemePacks(appearance);
  const selectedPack = resolveThemePack(appearance);
  const selectedIsCustom = appearance.customThemePacks.some((pack) => pack.id === selectedPack.id);

  useEffect(() => {
    previewAppearance(appearance);
  }, [appearance, previewAppearance]);

  useEffect(() => () => clearPreview(), [clearPreview]);

  useEffect(() => {
    setDeleteDialogOpen(false);
  }, [appearance.themePackId]);

  useEffect(() => {
    let active = true;
    const background = editingPack?.backgroundImage;
    if (!editingPack || !background) {
      setEditorBackgroundUrl(undefined);
      setEditorBackgroundSamples(undefined);
      setEditorBackgroundState("none");
      return () => {
        active = false;
      };
    }
    setEditorBackgroundUrl(undefined);
    setEditorBackgroundSamples(undefined);
    setEditorBackgroundState("loading");
    void appApi.resolveThemeBackground(editingPack.id, background.file)
      .then(async (asset) => {
        if (!active) return;
        if (!asset) {
          setEditorBackgroundState("missing");
          return;
        }
        const samples = await sampleThemeBackgroundUrl(asset.url, background.file);
        if (!active) return;
        setEditorBackgroundUrl(asset.url);
        setEditorBackgroundSamples(samples);
        setEditorBackgroundState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setEditorBackgroundState("error");
        console.error("[settings] 用户主题背景读取失败", {
          themeId: editingPack.id,
          file: background.file,
          error
        });
      });
    return () => {
      active = false;
    };
  }, [editingPack?.backgroundImage?.file, editingPack?.id]);

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
  async function openEditor(pack: ThemePackManifest, copy: boolean) {
    const cloned = cloneThemePack(pack);
    if (copy) {
      cloned.id = createCustomThemeId();
      cloned.name = `${pack.name} 自定义`;
      cloned.version = "1.0.0";
      cloned.author = "用户";
      if (cloned.backgroundImage) {
        setPackageAction("copying");
        try {
          await copyThemeBackgroundAsset(pack, cloned.id);
        } catch (error) {
          delete cloned.backgroundImage;
          toast.warning(error instanceof Error ? error.message : "原主题背景复制失败，已保留纯色主题");
        } finally {
          setPackageAction("idle");
        }
      }
    }
    setEditingPack(cloned);
    setEditorOpen(true);
  }

  /** 关闭主题编辑器并清理尚未应用的本地编辑副本。 */
  function closeEditor() {
    setEditorOpen(false);
    setEditingPack(null);
    setEditorBackgroundUrl(undefined);
    setEditorBackgroundSamples(undefined);
  }

  /** 校验并写入编辑后的用户主题，最终持久化仍由设置页保存按钮负责。 */
  async function saveEditedTheme() {
    if (!editingPack) {
      return;
    }
    const result = validateThemePack(editingPack);
    if (!result.pack) {
      toast.error(result.errors[0] ?? "主题校验失败");
      return;
    }
    setBackgroundAction("validating");
    try {
      if (result.pack.backgroundImage) {
        if (!editorBackgroundUrl || !editorBackgroundSamples) {
          throw new Error("主题背景图缺失，请重新上传或移除背景");
        }
        validateThemeBackgroundContrast(result.pack, editorBackgroundSamples);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主题背景校验失败");
      return;
    } finally {
      setBackgroundAction("idle");
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

  /** 删除当前用户主题并回退至内置默认主题。 */
  function deleteSelectedTheme() {
    if (!selectedIsCustom) {
      return;
    }
    onChange({
      ...appearance,
      themePackId: DEFAULT_THEME_PACK_ID,
      customThemePacks: appearance.customThemePacks.filter((pack) => pack.id !== selectedPack.id)
    });
    setDeleteDialogOpen(false);
    toast.success("用户主题已删除，请保存设置");
  }

  /** 导出纯色 JSON，或将背景图与 JSON 一并封装为 ZIP。 */
  async function exportSelectedTheme() {
    setPackageAction("exporting");
    try {
      const asset = selectedPack.backgroundImage
        ? await appApi.resolveThemeBackground(selectedPack.id, selectedPack.backgroundImage.file)
        : undefined;
      const result = await createThemeExport(selectedPack, asset?.url);
      const fileName = await appApi.exportThemePackage({
        fileName: result.fileName,
        contentType: result.fileName.endsWith(".zip") ? "application/zip" : "application/json",
        dataBase64: await blobToBase64(result.blob)
      });
      if (!fileName) return;
      toast.success(selectedPack.backgroundImage ? "主题 ZIP 已导出" : "主题 JSON 已导出");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主题包导出失败");
    } finally {
      setPackageAction("idle");
    }
  }

  /** 导入 JSON 或 ZIP；冲突标识会自动复制，ZIP 背景写入应用私有目录。 */
  async function importTheme(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setPackageAction("importing");
    try {
      const result = await readThemeImport(file);
      let imported = result.pack;
      if (themePacks.some((pack) => pack.id === imported.id)) {
        imported = { ...imported, id: createCustomThemeId(), name: `${imported.name} 导入` };
      }
      if (result.background) {
        const asset = await appApi.saveThemeBackground({
          themeId: imported.id,
          ...result.background.writeInput
        });
        imported = {
          ...imported,
          backgroundImage: imported.backgroundImage
            ? { ...imported.backgroundImage, file: asset.fileName }
            : undefined
        };
      }
      onChange({
        ...appearance,
        themePackId: imported.id,
        customThemePacks: [...appearance.customThemePacks, imported]
      });
      if (imported.backgroundImage && !result.background) {
        toast.warning("主题已导入，但背景图缺失，请编辑主题后上传");
      } else {
        toast.success("主题包已导入，请保存设置");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主题包导入失败");
    } finally {
      setPackageAction("idle");
    }
  }

  /** 压缩并保存用户选择的背景图片，同时写入安全遮罩默认值。 */
  async function uploadThemeBackground(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !editingPack) return;
    setBackgroundAction("uploading");
    try {
      const background = await normalizeThemeBackgroundFile(file);
      const nextPack = attachThemeBackground(editingPack, background);
      const asset = await appApi.saveThemeBackground({
        themeId: nextPack.id,
        ...background.writeInput
      });
      setEditingPack({
        ...nextPack,
        backgroundImage: nextPack.backgroundImage
          ? { ...nextPack.backgroundImage, file: asset.fileName }
          : undefined
      });
      setEditorBackgroundUrl(asset.url);
      setEditorBackgroundSamples(background.samples);
      setEditorBackgroundState("ready");
      toast.success("主题背景已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "主题背景处理失败");
    } finally {
      setBackgroundAction("idle");
    }
  }

  /** 移除主题中的背景引用，主题立即恢复纯色预览。 */
  function removeThemeBackground() {
    if (!editingPack?.backgroundImage) return;
    const { backgroundImage: _backgroundImage, ...pack } = editingPack;
    setEditingPack(pack);
    setEditorBackgroundUrl(undefined);
    setEditorBackgroundSamples(undefined);
    setEditorBackgroundState("none");
  }

  /** 修改背景焦点或当前模式遮罩强度。 */
  function updateThemeBackground(
    update: (background: NonNullable<ThemePackManifest["backgroundImage"]>) => NonNullable<ThemePackManifest["backgroundImage"]>
  ) {
    if (!editingPack?.backgroundImage) return;
    setEditingPack({ ...editingPack, backgroundImage: update(editingPack.backgroundImage) });
  }

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <header className="flex items-start gap-3 border-b bg-muted px-4 py-3 sm:px-5">
        <Palette aria-hidden="true" className="mt-0.5 size-5 text-primary" />
        <div className="min-w-0">
          <h3 className="font-semibold">主题与显示</h3>
          <p className="text-sm text-muted-foreground">明暗模式与主题包分别管理，选择后立即预览。</p>
        </div>
      </header>
      <div className="p-4 sm:p-5">
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
                    {pack.backgroundImage && <Badge tone="blue">背景图</Badge>}
                    <span className="text-xs font-normal text-muted-foreground">v{pack.version}</span>
                  </div>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          {selectedPack.backgroundImage && (backgroundState === "missing" || backgroundState === "error") && (
            <Alert variant="destructive">
              <ImageOff aria-hidden="true" />
              <AlertTitle>主题背景图不可用</AlertTitle>
              <AlertDescription>编辑当前用户主题并重新上传背景，或移除背景引用。</AlertDescription>
            </Alert>
          )}

          <Input
            ref={fileInputRef}
            id={fileInputId}
            className="hidden"
            type="file"
            accept=".json,.zip,.ani-theme.json,.ani-theme.zip,application/json,application/zip"
            onChange={(event) => void importTheme(event)}
          />
        </FieldGroup>
      </div>
      <footer className="flex flex-wrap gap-2 border-t px-4 py-3 sm:px-5">
        <Button
          variant="outline"
          disabled={packageAction !== "idle"}
          onClick={() => void openEditor(selectedPack, true)}
        >
          {packageAction === "copying"
            ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
            : <Plus data-icon="inline-start" />}
          {packageAction === "copying" ? "复制中" : "复制为自定义"}
        </Button>
        {selectedIsCustom && (
          <Button variant="outline" disabled={packageAction !== "idle"} onClick={() => void openEditor(selectedPack, false)}>
            <Pencil data-icon="inline-start" />
            编辑
          </Button>
        )}
        <Button variant="outline" disabled={packageAction !== "idle"} onClick={() => fileInputRef.current?.click()}>
          {packageAction === "importing"
            ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
            : <Upload data-icon="inline-start" />}
          {packageAction === "importing" ? "导入中" : "导入"}
        </Button>
        <Button variant="outline" disabled={packageAction !== "idle"} onClick={() => void exportSelectedTheme()}>
          {packageAction === "exporting"
            ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
            : <Download data-icon="inline-start" />}
          {packageAction === "exporting" ? "导出中" : "导出"}
        </Button>
        {selectedIsCustom && (
          <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 data-icon="inline-start" />
            删除
          </Button>
        )}
      </footer>

      {editorOpen && (
        <WorkbenchSheet
          className="sm:max-w-xl"
          description="修改开放的语义颜色和全局圆角，应用后仍需保存设置。"
          footer={(
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={resetEditedTheme}>
                <RotateCcw data-icon="inline-start" />
                恢复默认样式
              </Button>
              <Button variant="outline" onClick={closeEditor}>取消</Button>
              <Button disabled={backgroundAction !== "idle"} onClick={() => void saveEditedTheme()}>
                {backgroundAction === "validating"
                  ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
                  : <Copy data-icon="inline-start" />}
                {backgroundAction === "validating" ? "校验中" : "应用主题"}
              </Button>
            </div>
          )}
          onClose={closeEditor}
          title="编辑用户主题"
        >
          {editingPack && (
            <FieldGroup>
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
              <Field>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <FieldTitle>背景图片</FieldTitle>
                    <FieldDescription>可选；未设置时使用主题 JSON 中的纯色背景。</FieldDescription>
                  </div>
                  <BackgroundStateBadge state={editorBackgroundState} />
                </div>

                {editingPack.backgroundImage && (
                  <div className="relative aspect-video overflow-hidden rounded-md border bg-muted">
                    {editorBackgroundUrl ? (
                      <img
                        alt={`${editingPack.name}主题背景预览`}
                        className="size-full object-cover"
                        src={editorBackgroundUrl}
                        style={{
                          objectPosition: `${editingPack.backgroundImage.position.x}% ${editingPack.backgroundImage.position.y}%`
                        }}
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center text-muted-foreground">
                        <ImageOff aria-hidden="true" className="size-8" />
                        <span className="sr-only">背景图片不可用</span>
                      </div>
                    )}
                    <div
                      aria-hidden="true"
                      className="absolute inset-0"
                      style={{
                        backgroundColor: `hsl(${editingPack.tokens[resolvedTheme].background} / ${editingPack.backgroundImage.overlayOpacity[resolvedTheme]})`
                      }}
                    />
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={backgroundAction !== "idle"}
                    onClick={() => backgroundInputRef.current?.click()}
                  >
                    {backgroundAction === "uploading"
                      ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
                      : <ImageIcon data-icon="inline-start" />}
                    {backgroundAction === "uploading"
                      ? "处理中"
                      : editingPack.backgroundImage ? "替换背景" : "选择背景"}
                  </Button>
                  {editingPack.backgroundImage && (
                    <Button type="button" variant="outline" onClick={removeThemeBackground}>
                      <ImageOff data-icon="inline-start" />
                      移除背景
                    </Button>
                  )}
                </div>

                <Input
                  ref={backgroundInputRef}
                  id={backgroundInputId}
                  className="hidden"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  onChange={(event) => void uploadThemeBackground(event)}
                />

                {editingPack.backgroundImage && (
                  <FieldGroup className="gap-4">
                    <BackgroundSlider
                      label="水平焦点"
                      value={editingPack.backgroundImage.position.x}
                      valueLabel={`${Math.round(editingPack.backgroundImage.position.x)}%`}
                      minimum={0}
                      maximum={100}
                      step={1}
                      onChange={(x) => updateThemeBackground((background) => ({
                        ...background,
                        position: { ...background.position, x }
                      }))}
                    />
                    <BackgroundSlider
                      label="垂直焦点"
                      value={editingPack.backgroundImage.position.y}
                      valueLabel={`${Math.round(editingPack.backgroundImage.position.y)}%`}
                      minimum={0}
                      maximum={100}
                      step={1}
                      onChange={(y) => updateThemeBackground((background) => ({
                        ...background,
                        position: { ...background.position, y }
                      }))}
                    />
                    <BackgroundSlider
                      label="浅色遮罩"
                      value={editingPack.backgroundImage.overlayOpacity.light}
                      valueLabel={`${Math.round(editingPack.backgroundImage.overlayOpacity.light * 100)}%`}
                      minimum={0.55}
                      maximum={0.98}
                      step={0.01}
                      onChange={(light) => updateThemeBackground((background) => ({
                        ...background,
                        overlayOpacity: { ...background.overlayOpacity, light }
                      }))}
                    />
                    <BackgroundSlider
                      label="深色遮罩"
                      value={editingPack.backgroundImage.overlayOpacity.dark}
                      valueLabel={`${Math.round(editingPack.backgroundImage.overlayOpacity.dark * 100)}%`}
                      minimum={0.55}
                      maximum={0.98}
                      step={0.01}
                      onChange={(dark) => updateThemeBackground((background) => ({
                        ...background,
                        overlayOpacity: { ...background.overlayOpacity, dark }
                      }))}
                    />
                  </FieldGroup>
                )}
              </Field>
            </FieldGroup>
          )}
        </WorkbenchSheet>
      )}

      <ConfirmActionDialog
        confirmLabel="删除主题"
        description={`主题“${selectedPack.name}”将从用户主题列表中移除，并切换回默认主题。`}
        onConfirm={deleteSelectedTheme}
        onOpenChange={setDeleteDialogOpen}
        open={deleteDialogOpen}
        title="确认删除用户主题？"
      />
    </div>
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

/** 显示主题编辑器当前背景资产状态。 */
function BackgroundStateBadge({
  state
}: {
  state: "none" | "loading" | "ready" | "missing" | "error";
}) {
  if (state === "loading") return <Badge>读取中</Badge>;
  if (state === "ready") return <Badge tone="green">已设置</Badge>;
  if (state === "missing" || state === "error") return <Badge tone="red">图片缺失</Badge>;
  return <Badge>纯色</Badge>;
}

/** 渲染带当前数值的背景焦点或遮罩滑块。 */
function BackgroundSlider({
  label,
  value,
  valueLabel,
  minimum,
  maximum,
  step,
  onChange
}: {
  label: string;
  value: number;
  valueLabel: string;
  minimum: number;
  maximum: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const labelId = useId();
  return (
    <Field>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel id={labelId}>{label}</FieldLabel>
        <span className="text-sm tabular-nums text-muted-foreground">{valueLabel}</span>
      </div>
      <Slider
        aria-labelledby={labelId}
        min={minimum}
        max={maximum}
        step={step}
        value={[value]}
        onValueChange={(values) => {
          if (values[0] !== undefined) onChange(values[0]);
        }}
      />
    </Field>
  );
}

/** 将已有主题背景复制到新用户主题，避免新主题引用原目录。 */
async function copyThemeBackgroundAsset(source: ThemePackManifest, targetThemeId: string): Promise<void> {
  if (!source.backgroundImage) return;
  const asset = await appApi.resolveThemeBackground(source.id, source.backgroundImage.file);
  if (!asset) throw new Error("原主题背景缺失，已保留纯色主题");
  const contentType = parseThemeBackgroundContentType(asset.contentType);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error("原主题背景读取失败，已保留纯色主题");
  const blob = await response.blob();
  await appApi.saveThemeBackground({
    themeId: targetThemeId,
    fileName: source.backgroundImage.file,
    contentType,
    dataBase64: await blobToBase64(blob)
  });
}

/** 将宿主返回的内容类型收窄为主题背景白名单。 */
function parseThemeBackgroundContentType(value: string): "image/jpeg" | "image/png" | "image/webp" {
  if (value === "image/jpeg" || value === "image/png" || value === "image/webp") return value;
  throw new Error("主题背景格式无效");
}

/** 将受限主题文件按块转换为 Tauri IPC 使用的 Base64。 */
function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
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
