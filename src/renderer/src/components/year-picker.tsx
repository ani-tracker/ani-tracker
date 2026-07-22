import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/cn";

interface YearPickerProps {
  id?: string;
  value: number;
  onValueChange: (year: number) => void;
}

const yearsPerDecade = 10;
const yearColumns = 5;

/** 渲染支持十年翻页与键盘导航的年份选择器。 */
export function YearPicker({ id, value, onValueChange }: YearPickerProps) {
  const currentYear = new Date().getFullYear();
  const [open, setOpen] = useState(false);
  const [decadeStart, setDecadeStart] = useState(() => getDecadeStart(value));
  const contentRef = useRef<HTMLDivElement>(null);
  const years = Array.from({ length: yearsPerDecade }, (_, index) => decadeStart + index);

  useEffect(() => {
    if (open) setDecadeStart(getDecadeStart(value));
  }, [open, value]);

  /** 选择年份并关闭浮层。 */
  function selectYear(year: number) {
    console.info("[year-picker] 年份已选择", { year });
    onValueChange(year);
    setOpen(false);
  }

  /** 跨越十年边界后，将焦点落到目标年份。 */
  function focusYear(year: number) {
    const nextDecadeStart = getDecadeStart(year);
    if (nextDecadeStart !== decadeStart) setDecadeStart(nextDecadeStart);
    window.requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLButtonElement>(`[data-year="${year}"]`)?.focus();
    });
  }

  /** 使用方向键在年份网格中移动焦点。 */
  function handleYearKeyDown(event: KeyboardEvent<HTMLButtonElement>, year: number) {
    const offset = event.key === "ArrowLeft"
      ? -1
      : event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp"
          ? -yearColumns
          : event.key === "ArrowDown"
            ? yearColumns
            : 0;
    if (!offset) return;
    event.preventDefault();
    focusYear(year + offset);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-haspopup="dialog"
          className="w-full justify-between px-3 tabular-nums"
          id={id}
          type="button"
          variant="outline"
        >
          <span>{value} 年</span>
          <ChevronDown data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent ref={contentRef} align="start" className="w-72 p-3">
        <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2">
          <Button
            aria-label="查看上一个十年"
            className="size-9 p-0"
            onClick={() => setDecadeStart((current) => current - yearsPerDecade)}
            title="上一个十年"
            type="button"
            variant="ghost"
          >
            <ChevronLeft />
          </Button>
          <div className="text-center text-sm font-semibold tabular-nums">
            {decadeStart}–{decadeStart + yearsPerDecade - 1}
          </div>
          <Button
            aria-label="查看下一个十年"
            className="size-9 p-0"
            onClick={() => setDecadeStart((current) => current + yearsPerDecade)}
            title="下一个十年"
            type="button"
            variant="ghost"
          >
            <ChevronRight />
          </Button>
        </div>

        <div aria-label="选择年份" className="mt-3 grid grid-cols-5 gap-1">
          {years.map((year) => {
            const selected = year === value;
            const current = year === currentYear;
            return (
              <Button
                aria-current={current ? "date" : undefined}
                aria-selected={selected}
                className={cn(
                  "relative min-h-9 px-1 tabular-nums",
                  current && !selected && "border border-border"
                )}
                data-year={year}
                key={year}
                onClick={() => selectYear(year)}
                onKeyDown={(event) => handleYearKeyDown(event, year)}
                type="button"
                variant={selected ? "primary" : "ghost"}
              >
                {year}
                {selected && <Check className="absolute right-0.5 top-0.5" />}
              </Button>
            );
          })}
        </div>

        <Button
          className="mt-3 w-full"
          onClick={() => selectYear(currentYear)}
          type="button"
          variant="outline"
        >
          回到今年
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** 返回指定年份所属十年的起始年份。 */
function getDecadeStart(year: number): number {
  return Math.floor(year / yearsPerDecade) * yearsPerDecade;
}
