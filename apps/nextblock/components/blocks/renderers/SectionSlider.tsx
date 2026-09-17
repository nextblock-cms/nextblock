"use client";

import React, { useState, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { useTranslations } from "@nextblock-cms/utils";

interface SectionSliderProps {
  autoplay?: boolean;
  timeframe?: number; // In seconds
  children: React.ReactNode[];
  minHeight?: string;
}

// None of these keys is seeded yet; `t()` answers a missing key with the key itself.
const FALLBACK_LABELS: Record<string, { en: string; fr: string }> = {
  "slider.label": { en: "Slideshow", fr: "Diaporama" },
  "slider.slide": { en: "Slide {current} of {total}", fr: "Diapositive {current} sur {total}" },
  "slider.previous": { en: "Previous slide", fr: "Diapositive précédente" },
  "slider.next": { en: "Next slide", fr: "Diapositive suivante" },
  "slider.go_to": { en: "Go to slide {current}", fr: "Aller à la diapositive {current}" },
  "slider.pause": { en: "Pause slideshow", fr: "Mettre le diaporama en pause" },
  "slider.play": { en: "Play slideshow", fr: "Lancer le diaporama" },
};

// No `backdrop-blur-*`: a slider can be the hero, and hero content must not pay the
// first-frame compositing cost of a backdrop filter (project rule).
const ARROW_CLASS =
  "absolute top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-12 h-12 rounded-full border border-white/20 bg-black/30 hover:bg-black/50 text-white shadow-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-[opacity,transform,background-color] duration-300 hover:scale-105 active:scale-95 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white";

export default function SectionSlider({
  autoplay = false,
  timeframe = 5,
  children,
  minHeight = '400px',
}: SectionSliderProps) {
  const { lang, t } = useTranslations();
  const [currentIndex, setCurrentIndex] = useState(0);
  // Hover or keyboard focus inside the slider: a temporary pause.
  const [isPaused, setIsPaused] = useState(false);
  // The visitor pressed the pause button: stays paused until they press play.
  const [isStopped, setIsStopped] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const totalSlides = children.length;
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const label = (key: string, values: Record<string, number> = {}) => {
    const translated = t(key);
    const fallback = FALLBACK_LABELS[key];
    const template =
      translated !== key ? translated : lang.toLowerCase().startsWith("fr") ? fallback.fr : fallback.en;

    return Object.entries(values).reduce(
      (text, [name, value]) => text.replace(`{${name}}`, String(value)),
      template
    );
  };

  // Reset to first slide if children count changes
  useEffect(() => {
    setCurrentIndex(0);
  }, [totalSlides]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);

    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  // Autoplay never starts for visitors who ask for reduced motion; the arrows and dots
  // still work, and the global reduced-motion rule removes the cross-fade.
  const canAutoplay = autoplay && totalSlides > 1 && !prefersReducedMotion;

  useEffect(() => {
    if (!canAutoplay || isPaused || isStopped) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      return;
    }

    const intervalMs = timeframe * 1000;

    timerRef.current = setInterval(() => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % totalSlides);
    }, intervalMs);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [canAutoplay, timeframe, totalSlides, isPaused, isStopped]);

  const handlePrev = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev - 1 + totalSlides) % totalSlides);
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex((prev) => (prev + 1) % totalSlides);
  };

  const handleDotClick = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setCurrentIndex(index);
  };

  // Arrow keys move between slides, but only from the slider's own controls: a form field
  // or a link inside a slide keeps its normal arrow-key behaviour.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (totalSlides <= 1) return;
    if (!(event.target as HTMLElement).closest('[data-slider-control]')) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setCurrentIndex((prev) => (prev - 1 + totalSlides) % totalSlides);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setCurrentIndex((prev) => (prev + 1) % totalSlides);
    }
  };

  if (totalSlides === 0) {
    return null;
  }

  return (
    <div
      className="relative w-full overflow-hidden group"
      role="region"
      aria-roledescription="carousel"
      aria-label={label("slider.label")}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocusCapture={() => setIsPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsPaused(false);
      }}
      onKeyDown={handleKeyDown}
      style={{ minHeight }}
    >
      {/* Slides Container */}
      <div className="relative w-full" style={{ minHeight }}>
        {children.map((child, index) => {
          const isActive = index === currentIndex;
          return (
            <div
              key={index}
              role="group"
              aria-roledescription="slide"
              aria-label={label("slider.slide", { current: index + 1, total: totalSlides })}
              // Hidden slides are only transparent; `inert` keeps their links and buttons out
              // of the tab order and the accessibility tree.
              inert={!isActive}
              className={`w-full transition-opacity duration-700 ease-in-out ${
                isActive
                  ? "relative opacity-100 z-10 pointer-events-auto"
                  : "absolute inset-x-0 top-0 opacity-0 z-0 pointer-events-none"
              }`}
            >
              {child}
            </div>
          );
        })}
      </div>

      {/* Navigation Chevrons */}
      {totalSlides > 1 && (
        <>
          <button type="button" data-slider-control onClick={handlePrev} className={`${ARROW_CLASS} left-4`} aria-label={label("slider.previous")}>
            <ChevronLeft className="w-6 h-6 text-current" />
          </button>
          <button type="button" data-slider-control onClick={handleNext} className={`${ARROW_CLASS} right-4`} aria-label={label("slider.next")}>
            <ChevronRight className="w-6 h-6 text-current" />
          </button>
        </>
      )}

      {/* Navigation Dots, plus the pause control whenever the slider moves on its own */}
      {totalSlides > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 flex items-center justify-center gap-1">
          {canAutoplay && (
            <button
              type="button"
              data-slider-control
              onClick={(e) => {
                e.stopPropagation();
                setIsStopped((stopped) => !stopped);
              }}
              className="mr-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/30 text-white transition-colors hover:bg-black/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
              aria-label={label(isStopped ? "slider.play" : "slider.pause")}
            >
              {isStopped ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            </button>
          )}
          {children.map((_, index) => {
            const isActive = index === currentIndex;
            return (
              <button
                type="button"
                data-slider-control
                key={index}
                onClick={(e) => handleDotClick(index, e)}
                // The dot is 10px tall; the button around it is the 24px touch target.
                className="group/dot flex h-6 min-w-6 items-center justify-center rounded-full focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white"
                aria-label={label("slider.go_to", { current: index + 1 })}
                aria-current={isActive ? "true" : undefined}
              >
                <span
                  className={`block h-2.5 rounded-full border border-white/10 transition-colors duration-300 ${
                    isActive ? "w-7 bg-white shadow-md" : "w-2.5 bg-white/40 group-hover/dot:bg-white/70"
                  }`}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
