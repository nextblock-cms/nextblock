"use client"

import * as React from "react"
import { useOptionalTranslations } from "@nextblock-cms/utils"

/**
 * Shared by dialog.tsx and sheet.tsx (both wrap Radix Dialog).
 *
 * Radix wires `aria-describedby` to `<Description>` by itself, and warns in the console when
 * a dialog has none unless the content is given an explicit `aria-describedby={undefined}`.
 * The wrappers used to pass that `undefined` unconditionally to keep the console quiet, and
 * because it is spread after Radix's own id it always won: every DialogDescription in the
 * app was orphaned, including the "this will delete ..." text of the confirmation dialog.
 *
 * Here the description registers itself, so the explicit `undefined` is only passed when
 * there really is no description.
 */
const DescriptionPresenceContext = React.createContext<(() => () => void) | null>(null)

export function useDescriptionPresence() {
  const [count, setCount] = React.useState(0)
  const register = React.useCallback(() => {
    setCount((current) => current + 1)
    return () => setCount((current) => current - 1)
  }, [])

  return { hasDescription: count > 0, register }
}

export const DescriptionPresenceProvider = DescriptionPresenceContext.Provider

/** Call from the Description wrapper. A layout effect, so it lands before Radix's check. */
export function useRegisterDescription() {
  const register = React.useContext(DescriptionPresenceContext)

  React.useLayoutEffect(() => register?.(), [register])
}

/**
 * "Close" for the sr-only label of the X button: the visitor's language when a
 * TranslationsProvider is mounted (the NextBlock app), English for standalone consumers.
 */
export function useCloseLabel() {
  const translations = useOptionalTranslations()

  if (!translations) return "Close"

  const translated = translations.t("close")
  if (translated !== "close") return translated

  return translations.lang.toLowerCase().startsWith("fr") ? "Fermer" : "Close"
}
