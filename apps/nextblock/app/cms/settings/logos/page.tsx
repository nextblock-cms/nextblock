import Link from 'next/link'
import { Button } from '@nextblock-cms/ui'
import { getInvoiceBrandingData } from '@nextblock-cms/ecommerce/server'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@nextblock-cms/ui'
import { MoreHorizontal, PlusCircle, Edit3, Image as ImageIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuButtonTrigger,
  DropdownMenuSeparator,
} from '@nextblock-cms/ui'
import { getActiveLogoId, getLogos, getSiteSeoSettings } from './actions'
import BrandingSettingsForm from './components/BrandingSettingsForm'
import SiteSeoSettingsForm from './components/SiteSeoSettingsForm'
import MediaImage from '../../media/components/MediaImage'
import DeleteLogoButton from './components/DeleteLogoButton'
import SetActiveLogoButton from './components/SetActiveLogoButton'
import { resolveMediaUrl } from '../../../../lib/media/resolveMediaUrl'

function resolveLogoSrc(objectKey?: string | null) {
  return resolveMediaUrl(objectKey)
}

export default async function CmsLogosListPage() {
  const [logos, branding, seoSettings, pinnedActiveLogoId] = await Promise.all([
    getLogos(),
    getInvoiceBrandingData(),
    getSiteSeoSettings(),
    getActiveLogoId(),
  ])

  // The effective active logo: the admin-pinned one, else the most recent (logos come back
  // newest-first). This is what the storefront, invoices, and emails resolve to.
  const activeLogoId = pinnedActiveLogoId ?? logos[0]?.id ?? null

  return (
    <div className="w-full space-y-8">
      <div className="mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Branding</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage the site title &amp; SEO, the active website logo, and the seller details printed on invoices.
          </p>
        </div>
      </div>

      <SiteSeoSettingsForm initialSettings={seoSettings} />

      <BrandingSettingsForm initialSettings={branding.settings} />

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold">Logos</h2>
            <p className="text-sm text-muted-foreground">
              Choose which logo is active on the storefront, invoices, and emails. New logos
              become active automatically until you pick one.
            </p>
          </div>
          <Button variant="default" asChild>
            <Link href="/cms/settings/logos/new">
              <PlusCircle className="mr-2 h-4 w-4" /> New Logo
            </Link>
          </Button>
        </div>

        {logos.length === 0 ? (
          <div className="text-center py-10 border rounded-lg">
            <ImageIcon className="mx-auto h-12 w-12 text-muted-foreground" />
            <h3 className="mt-2 text-sm font-medium">No logos found.</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Get started by creating a new logo.
            </p>
            <div className="mt-6">
              <Button asChild>
                <Link href="/cms/settings/logos/new">
                  <PlusCircle className="mr-2 h-4 w-4" /> Create Logo
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">Image</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden md:table-cell">Created At</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logos.map((logo) => (
                  <TableRow key={logo.id}>
                    <TableCell>
                    {logo.media ? (
                      <MediaImage
                          src={resolveLogoSrc(logo.media.object_key) || ''}
                          alt={logo.name}
                          width={logo.media.width || 100}
                          height={logo.media.height || 100}
                          className="max-w-16 max-h-16 object-contain"
                        />
                      ) : (
                        <div className="w-16 h-16 bg-muted rounded-sm flex items-center justify-center">
                          <ImageIcon className="h-6 w-6 text-muted-foreground" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span>{logo.name}</span>
                        {logo.id === activeLogoId ? (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            Active
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {new Date(logo.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuButtonTrigger id={`logo-trigger-${logo.id}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </DropdownMenuButtonTrigger>
                        <DropdownMenuContent align="end">
                          {logo.id !== activeLogoId ? (
                            <>
                              <SetActiveLogoButton logoId={logo.id} />
                              <DropdownMenuSeparator />
                            </>
                          ) : null}
                          <DropdownMenuItem asChild>
                            <Link href={`/cms/settings/logos/${logo.id}/edit`}>
                              <Edit3 className="mr-2 h-4 w-4" />
                              Edit
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DeleteLogoButton logoId={logo.id} />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}
