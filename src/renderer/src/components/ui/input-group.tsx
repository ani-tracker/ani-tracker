import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";

/** 组合输入框及其内嵌操作区域。 */
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      className={cn(
        "group/input-group flex h-11 min-w-0 w-full items-center rounded-md border border-input bg-background shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring md:h-9",
        className
      )}
      {...props}
    />
  );
}

/** 渲染 InputGroup 内无独立边框的文本输入。 */
const InputGroupInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, ...props }, ref) => (
    <Input
      ref={ref}
      className={cn("h-full min-w-0 flex-1 rounded-none border-0 bg-transparent shadow-none focus-visible:ring-0", className)}
      {...props}
    />
  )
);
InputGroupInput.displayName = "InputGroupInput";

/** 承载输入框末端按钮并保持统一内边距。 */
function InputGroupAddon({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 items-center pr-1", className)} {...props} />;
}

/** 渲染 InputGroup 内的小型操作按钮。 */
function InputGroupButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return <Button type="button" variant="ghost" className={cn("min-h-8 px-2", className)} {...props} />;
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput };
