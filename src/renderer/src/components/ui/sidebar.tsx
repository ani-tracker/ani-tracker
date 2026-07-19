import {
  createContext,
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useMemo,
  useState
} from "react";
import { PanelLeft } from "lucide-react";
import { cn } from "@/lib/cn";

type SidebarContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

type SidebarProviderProps = HTMLAttributes<HTMLDivElement> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
};

export function SidebarProvider({
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: SidebarProviderProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;

  const value = useMemo<SidebarContextValue>(
    () => ({
      open,
      setOpen(nextOpen) {
        onOpenChange?.(nextOpen);
        if (controlledOpen === undefined) {
          setUncontrolledOpen(nextOpen);
        }
      },
      toggleSidebar() {
        const nextOpen = !open;
        onOpenChange?.(nextOpen);
        if (controlledOpen === undefined) {
          setUncontrolledOpen(nextOpen);
        }
      }
    }),
    [controlledOpen, onOpenChange, open]
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        className={cn(
          "fixed inset-0 flex h-screen h-dvh max-h-screen max-h-dvh w-full overflow-hidden bg-background text-foreground",
          className
        )}
        data-sidebar-wrapper=""
        style={
          {
            "--sidebar-width": "14rem",
            "--sidebar-width-icon": "4.5rem",
            ...style
          } as CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);

  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

export const Sidebar = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Sidebar(
  { className, ...props },
  ref
) {
  const { open } = useSidebar();

  return (
    <aside
      ref={ref}
      className={cn(
        "group/sidebar sticky top-0 flex h-screen h-dvh max-h-screen max-h-dvh w-[var(--sidebar-width)] shrink-0 flex-col self-start border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width]",
        "data-[state=collapsed]:w-[var(--sidebar-width-icon)]",
        className
      )}
      data-state={open ? "expanded" : "collapsed"}
      {...props}
    />
  );
});

export const SidebarInset = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function SidebarInset(
  { className, ...props },
  ref
) {
  return <main ref={ref} className={cn("min-w-0 flex-1 bg-background", className)} {...props} />;
});

export const SidebarHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SidebarHeader(
  { className, ...props },
  ref
) {
  return <div ref={ref} className={cn("border-b border-sidebar-border p-3", className)} {...props} />;
});

export const SidebarContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SidebarContent(
  { className, ...props },
  ref
) {
  return <div ref={ref} className={cn("min-h-0 flex-1 overflow-auto p-3", className)} {...props} />;
});

export const SidebarFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SidebarFooter(
  { className, ...props },
  ref
) {
  return <div ref={ref} className={cn("border-t border-sidebar-border p-4", className)} {...props} />;
});

export const SidebarGroup = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SidebarGroup(
  { className, ...props },
  ref
) {
  return <div ref={ref} className={cn("flex flex-col gap-2", className)} {...props} />;
});

export const SidebarGroupLabel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SidebarGroupLabel(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn("px-2 text-xs font-medium text-sidebar-foreground/60", className)}
      {...props}
    />
  );
});

export const SidebarGroupContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SidebarGroupContent({ className, ...props }, ref) {
    return <div ref={ref} className={cn("flex flex-col gap-1", className)} {...props} />;
  }
);
export const SidebarMenu = forwardRef<HTMLUListElement, HTMLAttributes<HTMLUListElement>>(function SidebarMenu(
  { className, ...props },
  ref
) {
  return <ul ref={ref} className={cn("flex flex-col gap-1", className)} {...props} />;
});

export const SidebarMenuItem = forwardRef<HTMLLIElement, HTMLAttributes<HTMLLIElement>>(function SidebarMenuItem(
  { className, ...props },
  ref
) {
  return <li ref={ref} className={cn("list-none", className)} {...props} />;
});

type SidebarMenuButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  isActive?: boolean;
  size?: "default" | "sm" | "lg";
};

const sidebarMenuButtonSizes: Record<NonNullable<SidebarMenuButtonProps["size"]>, string> = {
  default: "min-h-10 px-3",
  sm: "h-8 px-2",
  lg: "h-12 px-3"
};

export const SidebarMenuButton = forwardRef<HTMLButtonElement, SidebarMenuButtonProps>(
  function SidebarMenuButton({ className, isActive = false, size = "default", type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          "flex w-full items-center gap-3 overflow-hidden rounded-sm border-l-2 border-transparent text-left text-sm transition-colors",
          "text-sidebar-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-50",
          "data-[active=true]:border-sidebar-primary data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-primary",
          "[&>svg]:size-5 [&>svg]:shrink-0",
          sidebarMenuButtonSizes[size],
          className
        )}
        data-active={isActive}
        type={type}
        {...props}
      />
    );
  }
);

export const SidebarTrigger = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function SidebarTrigger({ className, onClick, type = "button", ...props }, ref) {
    const { toggleSidebar } = useSidebar();

    return (
      <button
        ref={ref}
        aria-label="切换侧边栏"
        className={cn(
          "inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        )}
        type={type}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            toggleSidebar();
          }
        }}
        {...props}
      >
        <PanelLeft />
      </button>
    );
  }
);
