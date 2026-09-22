import { appIconHref, type AppIconSource } from '../../../../../lib/branding/app-icon'

/**
 * Read-only preview of the installed-app icons, rendered from the active logo by
 * app/api/brand/app-icon (the same URLs the manifest and the apple-touch-icon link use).
 * There is nothing to edit: the icon follows whichever logo is active.
 */
export default function AppIconPreview({ source }: { source: AppIconSource }) {
  const isDefault = source.kind === 'default'

  return (
    <section className="space-y-4 rounded-xl border bg-background p-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">App icon</h2>
        <p className="text-sm text-muted-foreground">
          The icon visitors get when they install the site or add it to a home screen. It
          follows the active logo, so it updates when you change the logo. Square logos work
          best: a wide wordmark is shrunk to fit. The browser-tab favicon does not change.
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-8">
        <figure className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={appIconHref('maskable-512', source)}
            alt="Android app icon preview"
            width={96}
            height={96}
            className="h-24 w-24 rounded-full border"
          />
          <figcaption className="text-xs text-muted-foreground">Android</figcaption>
        </figure>
        <figure className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={appIconHref('apple-180', source)}
            alt="iPhone and iPad home-screen icon preview"
            width={96}
            height={96}
            className="h-24 w-24 rounded-[22%] border"
          />
          <figcaption className="text-xs text-muted-foreground">iPhone and iPad</figcaption>
        </figure>
      </div>

      {isDefault ? (
        <p className="text-xs text-muted-foreground">
          Showing the default NextBlock icon until a logo uploaded to your media library is
          active.
        </p>
      ) : null}
    </section>
  )
}
