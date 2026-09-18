"use client";
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@nextblock-cms/utils";

// Hover and pressed states move the surface AWAY from its own text colour instead of fading
// it toward the page: a fade lowers text contrast in whichever theme has the darker page
// (the seeded dark theme dropped below 4.5:1 on hover). The mix target is the button text
// with its lightness inverted (`oklch(from … calc(1 - l) 0 0)`): light text darkens the
// surface, dark text lightens it, so contrast rises on hover in every theme, whatever the
// palette. Browsers without relative colour syntax keep the rest colour. Numbers for the
// seeded themes are in docs/05. Both class names are spelled out in full: Tailwind only
// generates a utility it finds verbatim in the source, never one assembled at runtime.
const HOVER_MIX =
  "hover:[background-color:color-mix(in_oklab,hsl(var(--surface)),oklch(from_hsl(var(--surface-foreground))_calc(1_-_l)_0_0)_12%)] active:[background-color:color-mix(in_oklab,hsl(var(--surface)),oklch(from_hsl(var(--surface-foreground))_calc(1_-_l)_0_0)_20%)]";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: `bg-primary text-primary-foreground [--surface:var(--primary)] [--surface-foreground:var(--primary-foreground)] ${HOVER_MIX}`,
        destructive: `bg-destructive text-destructive-foreground [--surface:var(--destructive)] [--surface-foreground:var(--destructive-foreground)] ${HOVER_MIX}`,
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: `bg-secondary text-secondary-foreground [--surface:var(--secondary)] [--surface-foreground:var(--secondary-foreground)] ${HOVER_MIX}`,
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "rounded-md px-8 py-2 text-lg",
        icon: "h-10 w-10",
        full: "w-full h-12 rounded-md px-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
