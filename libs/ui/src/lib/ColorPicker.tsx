"use client";

import * as React from "react";
import type { ColorResult, SketchPickerProps } from "react-color";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./popover";
import { Label } from "./label";
import { Input } from "./input";
import { cn } from "@nextblock-cms/utils";

interface ColorPickerProps {
  label: string;
  color: string;
  onChange: (newColor: string) => void;
  className?: string;
}

const SketchPicker = React.lazy(async () => {
  const module = await import("react-color");
  return {
    default: module.SketchPicker as React.ComponentType<SketchPickerProps>,
  };
});

const ColorPicker = React.forwardRef<HTMLDivElement, ColorPickerProps>(
  ({ label, color, onChange, className }, ref) => {
    const handleColorChange = (newColor: ColorResult) => {
      const { r, g, b, a } = newColor.rgb;
      onChange(`rgba(${r}, ${g}, ${b}, ${a})`);
    };

    const inputId = React.useId();

    return (
      <div className={cn("space-y-1.5", className)} ref={ref}>
        <Label
          htmlFor={inputId}
          className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none"
        >
          {label}
        </Label>
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${label}: open the colour picker`}
                className="w-9 h-9 rounded-md border border-input cursor-pointer flex-shrink-0 shadow-sm transition-transform hover:scale-105 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                style={{ backgroundColor: color }}
              />
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <React.Suspense fallback={<div className="h-[276px] w-[220px]" />}>
                <SketchPicker color={color} onChangeComplete={handleColorChange} />
              </React.Suspense>
            </PopoverContent>
          </Popover>
          <Input
            id={inputId}
            value={color}
            onChange={(e) => onChange(e.target.value)}
            className="h-9 font-mono text-xs flex-1 min-w-[100px]"
            placeholder="#000000"
          />
        </div>
      </div>
    );
  }
);

ColorPicker.displayName = "ColorPicker";

export { ColorPicker };
