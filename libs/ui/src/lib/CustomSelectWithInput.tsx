"use client"

import * as React from "react"
import { Info } from "lucide-react"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"
import { Input } from "./input"
import { Label } from "./label"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

interface CustomSelectWithInputProps {
  label: string
  tooltipContent: React.ReactNode
  value: string
  onChange: (newValue: string) => void
  options: { value: string; label: string }[]
}

export function CustomSelectWithInput({
  label,
  tooltipContent,
  value,
  onChange,
  options,
}: CustomSelectWithInputProps) {
  const isCustomValue = !options.some(option => option.value === value)
  const [showCustomInput, setShowCustomInput] = React.useState(isCustomValue)

  const handleSelectChange = (selectValue: string) => {
    if (selectValue === "custom") {
      setShowCustomInput(true)
      // Do not call onChange here, wait for user input
    } else {
      setShowCustomInput(false)
      onChange(selectValue)
    }
  }

  const selectValue = isCustomValue ? "custom" : value
  const triggerId = React.useId()

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowCustomInput(isCustomValue)
  }, [isCustomValue])

  return (
    <div className="space-y-1.5">
      <div className="flex items-center">
        <Label
          htmlFor={triggerId}
          className="text-xs uppercase font-bold text-muted-foreground tracking-wider leading-none"
        >
          {label}
        </Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={`About ${label}`}
                className="ml-2 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="h-4 w-4 text-muted-foreground" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{tooltipContent}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {showCustomInput ? (
        <div className="flex gap-2">
          <div className="flex-1">
            <Select onValueChange={handleSelectChange} value={selectValue}>
              <SelectTrigger id={triggerId} className="h-9 text-sm">
                <SelectValue placeholder="Select a value" />
              </SelectTrigger>
              <SelectContent>
                {options.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input
            aria-label={`${label}: custom value`}
            className="flex-1 h-9 text-sm"
            value={isCustomValue ? value : ""}
            onChange={e => onChange(e.target.value)}
            placeholder="Enter custom value"
          />
        </div>
      ) : (
        <Select onValueChange={handleSelectChange} value={selectValue}>
          <SelectTrigger id={triggerId} className="h-9 text-sm">
            <SelectValue placeholder="Select a value" />
          </SelectTrigger>
          <SelectContent>
            {options.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  )
}