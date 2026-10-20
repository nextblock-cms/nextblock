// app/api/process-image/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@nextblock-cms/db/server';
import { getS3Client } from '@nextblock-cms/utils/server';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Readable } from 'stream';
import { getPlaiceholder } from 'plaiceholder';
import {
  getStorageBackend,
  getStorageBucket,
  resolveMediaBaseUrl,
} from '../../../lib/storage/provider';
import {
  supabaseDownloadObject,
  supabaseUploadObject,
} from '../../../lib/storage/supabase-storage';

// Helper to convert stream to buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

interface ProcessedImageVariant {
  objectKey: string;
  url: string;
  width: number;
  height: number;
  fileType: string; // e.g., 'image/avif'
  sizeBytes: number;
  variantLabel: string; // e.g., 'large_avif', 'medium_avif', 'thumbnail_avif', 'original_avif'
}

// Define target sizes (widths) and the AVIF format
const TARGET_SIZES = [
  { width: 1920, label: 'xlarge_avif' },
  { width: 1280, label: 'large_avif' },
  { width: 768, label: 'medium_avif' },
  { width: 384, label: 'small_avif' },
  { width: 128, label: 'thumbnail_avif' }, // For very small previews or blur placeholders
];
const TARGET_FORMAT = 'avif';
const TARGET_MIME_TYPE = 'image/avif';

export async function POST(request: NextRequest) {
  // This endpoint reads AND writes arbitrary storage objects by key with the server's storage
  // credentials, so it must not be callable unauthenticated. It is a CMS tool (the media upload
  // pipeline), reachable only from /cms, so require a staff session. Without this, an anonymous
  // caller could read any object by key (blur-preview exfiltration), write processed variants, or
  // drive sharp to exhaust the server.
  {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role !== 'ADMIN' && profile?.role !== 'WRITER') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const backend = getStorageBackend();
  const bucket = getStorageBucket();
  const publicUrlBase = resolveMediaBaseUrl();

  if (!bucket) {
    return NextResponse.json({ error: 'Storage bucket is not configured.' }, { status: 500 });
  }
  // The native Supabase path derives the public base from the project URL — if that's
  // somehow empty (e.g. STORAGE_PROVIDER=supabase forced without a URL), fail loudly
  // rather than minting malformed `/key` URLs that won't resolve to the bucket.
  if (backend === 'supabase' && !publicUrlBase) {
    return NextResponse.json({ error: 'Supabase URL is required for image processing on the Supabase backend.' }, { status: 500 });
  }
  // The S3 path needs an endpoint to construct the public URL base; the native Supabase
  // path derives it from the project URL, so this check only applies to S3/R2.
  if (backend === 's3' && !process.env.R2_S3_ENDPOINT && !process.env.R2_ACCOUNT_ID) {
    console.error('R2_S3_ENDPOINT or R2_ACCOUNT_ID must be set to construct the public URL base');
    return NextResponse.json({ error: 'Server configuration error for storage public URL.' }, { status: 500 });
  }


  try {
    const s3Client = backend === 's3' ? await getS3Client() : null;
    if (backend === 's3' && !s3Client) {
      console.error('R2 client is not configured. Check your R2 environment variables.');
      return NextResponse.json({ error: 'Image processing is not configured on this server.' }, { status: 500 });
    }

    // Backend-agnostic object writer used for every processed variant below.
    const putObject = async (key: string, body: Buffer, contentType: string) => {
      if (backend === 'supabase') {
        await supabaseUploadObject(key, body, contentType);
      } else {
        await s3Client!.send(
          new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
        );
      }
    };

    const { objectKey: originalObjectKey, contentType: originalContentType } = await request.json();

    if (!originalObjectKey || !originalContentType) {
      return NextResponse.json({ error: 'Missing objectKey or contentType in request body.' }, { status: 400 });
    }

    // Constrain the key to a plain in-bucket relative path: no traversal, no leading slash, no
    // scheme/host. Defence in depth behind the staff gate above so a key cannot be aimed outside
    // the media namespace.
    if (
      typeof originalObjectKey !== 'string' ||
      originalObjectKey.includes('..') ||
      originalObjectKey.startsWith('/') ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(originalObjectKey)
    ) {
      return NextResponse.json({ error: 'Invalid objectKey.' }, { status: 400 });
    }

    if (!originalContentType.startsWith('image/')) {
      // For now, we only process images. Could be extended for other file types if needed.
      return NextResponse.json({
        message: 'File is not an image. Skipping processing.',
        originalImage: { objectKey: originalObjectKey, fileType: originalContentType, url: `${publicUrlBase}/${originalObjectKey}` },
        processedVariants: [],
        blurDataURL: null // Or an empty string, depending on how you want to handle non-images
      }, { status: 200 });
    }

    // 1. Fetch the original image from storage
    let imageBuffer: Buffer;
    if (backend === 'supabase') {
      imageBuffer = await supabaseDownloadObject(originalObjectKey);
    } else {
      const getObjectResponse = await s3Client!.send(
        new GetObjectCommand({ Bucket: bucket, Key: originalObjectKey }),
      );
      if (!getObjectResponse.Body) {
        throw new Error('Failed to retrieve image from storage: Empty body.');
      }
      imageBuffer = await streamToBuffer(getObjectResponse.Body as Readable);
    }
    // Cap decode cost: reject absurdly large images rather than letting sharp allocate for them.
    let sharpInstance = sharp(imageBuffer, { limitInputPixels: 50_000_000, failOn: 'error' });
    let originalMetadata = await sharpInstance.metadata();

    const MAX_WIDTH = 2560; // Define max width

    // Check if the image width is greater than MAX_WIDTH
    if (originalMetadata.width && originalMetadata.width > MAX_WIDTH) {
      // Resize the image
      const resizedBuffer = await sharpInstance
        .resize({
          width: MAX_WIDTH,
          // height is scaled automatically to maintain aspect ratio
        })
        .toBuffer();
      
      // Update buffer and sharp instance for all subsequent operations
      imageBuffer = resizedBuffer;
      sharpInstance = sharp(imageBuffer);
      // Update metadata as well
      originalMetadata = await sharpInstance.metadata();
    }

    const processedVariants: ProcessedImageVariant[] = [];
    const baseName = originalObjectKey.substring(0, originalObjectKey.lastIndexOf('.'));
    // const originalExtension = originalObjectKey.substring(originalObjectKey.lastIndexOf('.') + 1);

    // 2. Process and upload variants (resized AVIF)
    for (const size of TARGET_SIZES) {
      if (!originalMetadata.width) continue; // Skip if original width is unknown

      const targetWidth = Math.min(size.width, originalMetadata.width); // Don't upscale beyond original
      
      const processedImageBuffer = await sharpInstance
        .clone() // Important: clone before each new operation
        .resize({ width: targetWidth, withoutEnlargement: true })
        .toFormat(TARGET_FORMAT, { quality: 75 }) // Adjust quality as needed
        .toBuffer();
      
      // size.label keeps its '_avif' suffix as the stored variantLabel (used for
      // variant selection), but it's redundant in the filename since the extension is
      // already .avif — strip it so keys read `..._large.avif`, not `..._large_avif.avif`.
      const fileSuffix = size.label.replace(/_avif$/, '');
      const newObjectKey = `${baseName}_${fileSuffix}.${TARGET_FORMAT}`;
      const newPublicUrl = `${publicUrlBase}/${newObjectKey}`;

      await putObject(newObjectKey, processedImageBuffer, TARGET_MIME_TYPE);

      const newMetadata = await sharp(processedImageBuffer).metadata();
      processedVariants.push({
        objectKey: newObjectKey,
        url: newPublicUrl,
        width: newMetadata.width || targetWidth,
        height: newMetadata.height || 0, // Sharp should provide this
        fileType: TARGET_MIME_TYPE,
        sizeBytes: processedImageBuffer.length,
        variantLabel: size.label,
      });
    }

    // 3. Optionally, convert the original image to AVIF if it's not already (and keep original size)
    // This gives an AVIF version of the original uploaded image.
    if (originalContentType !== TARGET_MIME_TYPE) {
        const originalAvifBuffer = await sharp(imageBuffer)
            .clone()
            .toFormat(TARGET_FORMAT, { quality: 80 }) // Potentially higher quality for "original" AVIF
            .toBuffer();
        
        const originalAvifObjectKey = `${baseName}_original.${TARGET_FORMAT}`;
        const originalAvifPublicUrl = `${publicUrlBase}/${originalAvifObjectKey}`;

        await putObject(originalAvifObjectKey, originalAvifBuffer, TARGET_MIME_TYPE);
        const originalAvifMetadata = await sharp(originalAvifBuffer).metadata();
        processedVariants.push({
            objectKey: originalAvifObjectKey,
            url: originalAvifPublicUrl,
            width: originalAvifMetadata.width || originalMetadata.width || 0,
            height: originalAvifMetadata.height || originalMetadata.height || 0,
            fileType: TARGET_MIME_TYPE,
            sizeBytes: originalAvifBuffer.length,
            variantLabel: 'original_avif',
        });
    }


    // Include original image details (even if not AVIF) for reference in the database
    // The client already has some of this, but good to have a consistent structure.
    const originalImageDetails: ProcessedImageVariant = {
        objectKey: originalObjectKey,
        url: `${publicUrlBase}/${originalObjectKey}`,
        width: originalMetadata.width || 0,
        height: originalMetadata.height || 0,
        fileType: originalContentType,
        sizeBytes: imageBuffer.length,
        variantLabel: 'original_uploaded',
    };

    // Generate blurDataURL
    const { base64: blurDataURL } = await getPlaiceholder(imageBuffer, { size: 10 });
 
    return NextResponse.json({
        message: 'Image processed successfully.',
        originalImage: originalImageDetails,
        processedVariants,
        blurDataURL
    }, { status: 200 });

  } catch (error: unknown) {
    console.error('Error processing image:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: 'Failed to process image.', details: errorMessage }, { status: 500 });
  }
}
