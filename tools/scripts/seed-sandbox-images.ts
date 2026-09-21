
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';

// Environment comes from the caller: the root db:push:sandbox script runs this file
// through dotenv 18's CLI (`dotenv run -q -f .env.local -- npx tsx ...`), which
// populates process.env from .env.local.

async function seedImages() {
  const r2AccountId = process.env.R2_ACCOUNT_ID;
  const r2AccessKeyId = process.env.R2_ACCESS_KEY_ID;
  const r2SecretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const r2BucketName = process.env.R2_BUCKET_NAME;

  if (!r2AccountId || !r2AccessKeyId || !r2SecretAccessKey || !r2BucketName) {
    console.error('Missing R2 environment variables. Skipping image seeding.');
    console.error('Needed: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME');
    process.exit(1);
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2AccessKeyId,
      secretAccessKey: r2SecretAccessKey,
    },
  });

  const uploads = [
    {
      filePath: 'apps/nextblock/public/images/nextblock-logo-small.webp',
      key: 'images/nextblock-logo-small.webp',
      contentType: 'image/webp',
    },
    {
        filePath: 'apps/nextblock/public/images/goals.webp',
        key: 'images/goals.webp',
        contentType: 'image/webp',
    },
    {
        filePath: 'apps/nextblock/public/images/programmer-upscaled.webp',
        key: 'images/programmer-upscaled.webp',
        contentType: 'image/webp',
    }
  ];

  console.log('Seeding sandbox images to R2...');

  for (const upload of uploads) {
    try {
      const fullPath = path.resolve(process.cwd(), upload.filePath);
      if (!fs.existsSync(fullPath)) {
          console.error(`File not found locally: ${fullPath}`);
          continue;
      }

      // Check if exists
      try {
        await s3.send(new HeadObjectCommand({
          Bucket: r2BucketName,
          Key: upload.key,
        }));
        console.log(`ℹ️  Skipped (Already Exists): ${upload.key}`);
        continue;
      } catch (error: any) {
        // If 404, proceed to upload. Otherwise throw.
        if (error.name !== 'NotFound' && error.$metadata?.httpStatusCode !== 404) {
             throw error;
        }
      }
      
      const fileBuffer = fs.readFileSync(fullPath);

      await s3.send(new PutObjectCommand({
        Bucket: r2BucketName,
        Key: upload.key,
        Body: fileBuffer,
        ContentType: upload.contentType,
      }));

      console.log(`✅ Uploaded: ${upload.key}`);
    } catch (error) {
      console.error(`❌ Failed to process ${upload.key}:`, error);
      process.exit(1);
    }
  }

  console.log('Sandbox image seeding complete.');
}

seedImages().catch((err) => {
  console.error('Unexpected error during seeding:', err);
  process.exit(1);
});
