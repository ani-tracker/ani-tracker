import * as React from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const Pagination = ({ className, ...props }: React.ComponentProps<"nav">) => (
  <nav
    aria-label="分页导航"
    className={cn("flex w-full justify-center", className)}
    role="navigation"
    {...props}
  />
);
Pagination.displayName = "Pagination";

const PaginationContent = React.forwardRef<
  HTMLUListElement,
  React.ComponentProps<"ul">
>(({ className, ...props }, ref) => (
  <ul ref={ref} className={cn("flex flex-row items-center gap-1", className)} {...props} />
));
PaginationContent.displayName = "PaginationContent";

const PaginationItem = React.forwardRef<
  HTMLLIElement,
  React.ComponentProps<"li">
>(({ className, ...props }, ref) => <li ref={ref} className={className} {...props} />);
PaginationItem.displayName = "PaginationItem";

type PaginationLinkProps = React.ComponentProps<"button"> & {
  isActive?: boolean;
};

const PaginationLink = React.forwardRef<HTMLButtonElement, PaginationLinkProps>(
  ({ className, isActive, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      aria-current={isActive ? "page" : undefined}
      className={cn(buttonClassName(isActive ? "primary" : "ghost", "size-11 p-0 md:size-9"), className)}
      type={type}
      {...props}
    />
  )
);
PaginationLink.displayName = "PaginationLink";

const PaginationPrevious = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof PaginationLink>
>(({ className, ...props }, ref) => (
  <PaginationLink ref={ref} aria-label="上一页" className={className} {...props}>
    <ChevronLeft />
  </PaginationLink>
));
PaginationPrevious.displayName = "PaginationPrevious";

const PaginationNext = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof PaginationLink>
>(({ className, ...props }, ref) => (
  <PaginationLink ref={ref} aria-label="下一页" className={className} {...props}>
    <ChevronRight />
  </PaginationLink>
));
PaginationNext.displayName = "PaginationNext";

const PaginationEllipsis = ({ className, ...props }: React.ComponentProps<"span">) => (
  <span
    aria-hidden
    className={cn("flex size-9 items-center justify-center [&_svg]:size-4", className)}
    {...props}
  >
    <MoreHorizontal />
    <span className="sr-only">更多页码</span>
  </span>
);
PaginationEllipsis.displayName = "PaginationEllipsis";

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious
};
