import type { FansubGroup, Release } from "./domain";

/** 规范化字幕组匹配文本：移除全部空白并忽略字母大小写。 */
export function normalizeFansubMatchName(value: string): string {
  return value.trim().replace(/\s+/gu, "").toLowerCase();
}

/** 清理候补字幕组名单，并按匹配规则稳定去重。 */
export function normalizeCandidateFansubNames(values: readonly string[]): string[] {
  const normalizedNames = new Set<string>();

  return values.flatMap((value) => {
    const displayName = value.trim();
    const normalizedName = normalizeFansubMatchName(displayName);
    if (!normalizedName || normalizedNames.has(normalizedName)) {
      return [];
    }

    normalizedNames.add(normalizedName);
    return [displayName];
  });
}

/** 判断资源字幕组是否完整命中任一候补名称或已知别名。 */
export function matchesCandidateFansub(
  release: Pick<Release, "fansubGroupId" | "fansubName">,
  candidateNames: readonly string[],
  groups: readonly FansubGroup[] = []
): boolean {
  const normalizedCandidates = new Set(
    candidateNames.map(normalizeFansubMatchName).filter(Boolean)
  );
  if (!normalizedCandidates.size) {
    return false;
  }

  const releaseFansubName = release.fansubName
    ? normalizeFansubMatchName(release.fansubName)
    : "";
  if (releaseFansubName && normalizedCandidates.has(releaseFansubName)) {
    return true;
  }

  const matchedGroup = groups.find((group) =>
    group.id === release.fansubGroupId ||
    Boolean(releaseFansubName && [group.name, ...group.aliases].some(
      (name) => normalizeFansubMatchName(name) === releaseFansubName
    ))
  );
  return Boolean(matchedGroup && [matchedGroup.name, ...matchedGroup.aliases].some(
    (name) => normalizedCandidates.has(normalizeFansubMatchName(name))
  ));
}
