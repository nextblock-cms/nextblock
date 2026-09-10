-- 00000000000039_mcp_guide_diagram_dimensions.sql
--
-- 00000000000038 registered public/images/mcp-prompt-to-production.webp at 2000x1025.
-- The rendered figure was blurry because next/image was told it displays at 768px,
-- re-encoded it as quality-60 AVIF and the browser upscaled the result to the
-- full article width. The asset is now re-rendered at 2560x1312
-- and served unoptimized (see ClientTextBlockRenderer's knownCmsImages); this
-- brings the media-library row in line with the file on disk. 038 is already
-- applied, so this is a separate file.
--
-- Idempotent: keyed by media.object_key, guarded on the values differing.

UPDATE public.media
   SET width      = 2560,
       height     = 1312,
       size_bytes = 156358,
       updated_at = now()
 WHERE object_key = 'images/mcp-prompt-to-production.webp'
   AND (width IS DISTINCT FROM 2560
        OR height IS DISTINCT FROM 1312
        OR size_bytes IS DISTINCT FROM 156358);
