// scripts/backfill-image-meta.ts
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { Readable } from 'stream';
import { getPlaiceholder } from 'plaiceholder';
import 'dotenv/config';
import * as dotenv from 'dotenv';
import { readAllMediaRows } from '../lib/media/media-pages';

dotenv.config({ path: '.env.local' });

// Helper to convert stream to buffer
async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(chunk as Buffer));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_WIDTH = 2560;

async function backfillImageMeta() {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: Bucket,
  } = process.env;

  if (
    !R2_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !Bucket
  ) {
    console.error('Cloudflare R2 environment variables are not fully set.');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Supabase environment variables are not set.');
    process.exit(1);
  }

  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch all media records, in pages: one PostgREST request stops at 1000 rows without an error.
  const { data: mediaItems, error } = await readAllMediaRows<{ id: string; object_key: string; width: number | null }>(
    (from, to) => supabase.from('media').select('id, object_key, width').order('id', { ascending: true }).range(from, to)
  );

  if (error) {
    console.error('Error fetching media items:', error);
    return;
  }

  if (!mediaItems || mediaItems.length === 0) {
    console.log('No images to backfill.');
    return;
  }

  console.log(`Found ${mediaItems.length} images to process.`);

  for (const item of mediaItems) {
    try {
      if (item.width && item.width > MAX_WIDTH) {
        console.log(`Resizing image ${item.id} (${item.object_key}) from ${item.width}px wide.`);

        // 1. Download the image from R2
        const getObjectParams = {
          Bucket: R2_BUCKET_NAME,
          Key: item.object_key,
        };
        const getObjectResponse = await s3Client.send(new GetObjectCommand(getObjectParams));

        if (!getObjectResponse.Body) {
          throw new Error('Failed to retrieve image from R2: Empty body.');
        }

        const imageBuffer = await streamToBuffer(getObjectResponse.Body as Readable);

        // 2. Resize the image
        const resizedImageBuffer = await sharp(imageBuffer)
          .resize({
            width: MAX_WIDTH,
            withoutEnlargement: true,
          })
          .toBuffer();

        // 3. Upload the resized image back to R2, overwriting the original
        const putObjectParams = {
          Bucket: R2_BUCKET_NAME,
          Key: item.object_key,
          Body: resizedImageBuffer,
          ContentType: getObjectResponse.ContentType,
        };
        await s3Client.send(new PutObjectCommand(putObjectParams));

        // 4. Get new metadata from the resized image
        const sharpInstance = sharp(resizedImageBuffer);
        const metadata = await sharpInstance.metadata();
        const { base64: blurDataURL } = await getPlaiceholder(resizedImageBuffer, { size: 10 });

        const { width, height } = metadata;

        if (!width || !height) {
          console.warn(`Could not extract new width/height for ${item.object_key}. Skipping update.`);
          continue;
        }

        // 5. Update the record in the media table
        const { error: updateError } = await supabase
          .from('media')
          .update({
            width,
            height,
            blur_data_url: blurDataURL,
            updated_at: new Date().toISOString(),
          })
          .eq('id', item.id);

        if (updateError) {
          console.error(`Failed to update item ${item.id}:`, updateError);
        } else {
          console.log(`Successfully resized and updated item ${item.id}.`);
        }
      } else {
        console.log(`Skipping image ${item.id} (${item.object_key}) - not oversized.`);
      }
    } catch (e: unknown) {
      console.error(`An error occurred while processing item ${item.id}:`, e instanceof Error ? e.message : String(e));
    }
  }

  console.log('Backfill complete.');
}

backfillImageMeta();