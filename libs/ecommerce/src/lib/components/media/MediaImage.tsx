// app/cms/media/components/MediaImage.tsx
"use client";

import React from 'react'
import Image from 'next/image'
import { cn } from '@nextblock-cms/utils/utils'

interface MediaImageProps {
  src: string
  alt: string
  width?: number | null
  height?: number | null
  blurDataURL?: string | null
  className?: string
  priority?: boolean
}

const MediaImage: React.FC<MediaImageProps> = ({
  src,
  alt,
  width,
  height,
  blurDataURL,
  className,
  priority = false,
}) => {
  const isValid = src && width && height && width > 0 && height > 0

  if (!isValid) {
    const placeholderWidth = typeof width === 'number' && width > 0 ? width : 100
    const placeholderHeight =
      typeof height === 'number' && height > 0 ? height : 100

    const hasSizeClass = className?.includes('w-') || className?.includes('h-')

    return (
      <div
        className={cn(
          'bg-muted text-muted-foreground flex items-center justify-center',
          className,
        )}
        style={
          !hasSizeClass
            ? {
                width: placeholderWidth,
                height: placeholderHeight,
              }
            : {}
        }
      >
        Invalid Image
      </div>
    )
  }

  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      placeholder={blurDataURL ? 'blur' : 'empty'}
      blurDataURL={blurDataURL || undefined}
      priority={priority}
    />
  )
}

export default MediaImage