// app/cms/media/components/MediaUploadForm.tsx
"use client";

import React, { useState, useRef, useTransition, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Button } from "@nextblock-cms/ui";
import { Spinner, Alert, AlertDescription } from "@nextblock-cms/ui";
import { Input } from "@nextblock-cms/ui";
import { Label } from "@nextblock-cms/ui";
import { Progress } from "@nextblock-cms/ui"; // Assuming you have this shadcn/ui component
import { UploadCloud, XCircle, CheckCircle2 } from "lucide-react";
import type { Database } from "@nextblock-cms/db"; // Import Media type

type Media = Database['public']['Tables']['media']['Row'];


interface MediaUploadFormProps {
  onUploadSuccess?: (newMedia: Media) => void;
  // If true, the form expects recordMediaUpload to return data instead of redirecting.
  // And will use onUploadSuccess instead of router.refresh().
  returnJustData?: boolean;
  defaultFolder?: string; // Optional pre-populated folder
  // If true, tightens spacing/heights so the form fits inside a modal on shorter screens.
  compact?: boolean;
}

import { useUploadFolder } from "../UploadFolderContext";

export default function MediaUploadForm({ onUploadSuccess, returnJustData, defaultFolder, compact }: MediaUploadFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null); // For image preview
  const [imageDimensions, setImageDimensions] = useState<{ width: number; height: number } | null>(null); // For image dimensions
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false); // For drag-and-drop visual feedback
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [processingStatus, setProcessingStatus] = useState<"idle" | "processing" | "processed_error">("idle");
  const { defaultFolder: ctxDefaultFolder } = useUploadFolder();
  const [folder, setFolder] = useState<string>(defaultFolder || ctxDefaultFolder || "uploads/");

  useEffect(() => {
    setFolder(defaultFolder || ctxDefaultFolder || "uploads/");
  }, [defaultFolder, ctxDefaultFolder]);

  const resetFileSelection = () => {
    setFile(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewUrl(null);
    setImageDimensions(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const processFile = (selectedFile: File | undefined | null) => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl); // Clean up previous preview
      setPreviewUrl(null);
    }
    setImageDimensions(null); // Reset dimensions

    if (selectedFile) {
      setFile(selectedFile);
      setUploadStatus("idle");
      setUploadProgress(0);
      setErrorMessage(null);

      if (selectedFile.type.startsWith("image/")) {
        const localPreviewUrl = URL.createObjectURL(selectedFile);
        setPreviewUrl(localPreviewUrl);

        // Get image dimensions
        const img = new window.Image();
        img.onload = () => {
          setImageDimensions({ width: img.naturalWidth, height: img.naturalHeight });
          URL.revokeObjectURL(img.src); // Clean up object URL used for dimensions
        };
        img.onerror = () => {
          console.error("Error loading image to get dimensions.");
          setImageDimensions(null);
          URL.revokeObjectURL(img.src); // Clean up object URL used for dimensions
        };
        img.src = URL.createObjectURL(selectedFile); // Create a new object URL for dimension calculation
      }
    } else {
      setFile(null); // Clear file if selection is cancelled or no file
      // If previewUrl was set, it's already handled by the block at the start of this function
      // or should be cleared if we are explicitly clearing the file.
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    processFile(selectedFile);
  };

  const handleDragEnter = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragOver = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // You can add more checks here if needed, e.g., event.dataTransfer.types
    setIsDraggingOver(true); // Ensure it stays true if dragging over children
  };

  const handleDragLeave = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // Check if the mouse is leaving the droppable area for real
    // and not just moving over a child element.
    // This can be tricky. A simpler approach is to rely on onDragEnter/onDrop to set it.
    // For now, let's keep it simple:
    setIsDraggingOver(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingOver(false);

    const droppedFiles = event.dataTransfer.files;
    if (droppedFiles && droppedFiles.length > 0) {
      // Process the first file, like in handleFileChange
      const droppedFile = droppedFiles[0];
      processFile(droppedFile);
      // If you want to clear the file input after a drop (optional)
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };



  const performUpload = async () => {
    if (!file) {
      setErrorMessage("Please select a file to upload.");
      return;
    }
    if (isPending || uploadStatus === "uploading" || processingStatus === "processing") {
      return;
    }

    setUploadStatus("uploading");
    setUploadProgress(50); // Indicate start of upload
    setErrorMessage(null);
    setProcessingStatus("idle");

    const currentFileForUpload = file;

    startTransition(async () => {
      try {
        // 1. Upload file via proxy
        const formData = new FormData();
        formData.append('file', currentFileForUpload);
        if (folder) {
          formData.append('folder', folder);
        }

        const proxyResponse = await fetch('/api/upload/proxy', {
          method: 'POST',
          body: formData,
        });

        if (!proxyResponse.ok) {
          const errorData = await proxyResponse.json();
          throw new Error(errorData.error || 'Failed to upload file via proxy.');
        }

        const { objectKey } = await proxyResponse.json();
        setUploadProgress(100);

        // 2. Record media in Supabase
        // Derive a default alt/description for images when none provided
        const deriveAltFromFilename = (name: string) => {
          const lastDot = name.lastIndexOf('.');
          const base = lastDot > 0 ? name.substring(0, lastDot) : name;
          const spaced = base.replace(/[-+_\\]+/g, ' ').replace(/\s+/g, ' ').trim();
          // Title-case words
          return spaced.replace(/\b\w+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
        };

        const defaultDescription = currentFileForUpload.type.startsWith('image/')
          ? deriveAltFromFilename(currentFileForUpload.name)
          : undefined;

        const mediaDataPayload = {
          fileName: currentFileForUpload.name,
          objectKey: objectKey,
          fileType: currentFileForUpload.type,
          sizeBytes: currentFileForUpload.size,
          width: imageDimensions?.width,
          height: imageDimensions?.height,
          description: defaultDescription,
        };

        // 3. Process image variants
        setProcessingStatus("processing");
        const processResponse = await fetch('/api/process-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            objectKey: objectKey,
            contentType: currentFileForUpload.type,
          }),
        });

        const processData = await processResponse.json();

        if (!processResponse.ok) {
          console.error("Error processing image:", processData.error || "Failed to process image variants.");
          setProcessingStatus("processed_error");
          setErrorMessage(`Original uploaded, but variants failed: ${processData.error || "Unknown error"}`);
        } else {
          setProcessingStatus("idle");
        }

        // 4. Record media in Supabase with variant info
        const finalMediaPayload = {
          ...mediaDataPayload,
          r2OriginalKey: objectKey,
          r2Variants: processData.processedVariants || [],
          originalImageDetails: processData.originalImage,
          blurDataUrl: processData.blurDataURL || null,
        };

        const recordResponse = await fetch('/api/media/record', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(finalMediaPayload),
        });

        const recordResult = await recordResponse.json();

        if (!recordResponse.ok) {
          throw new Error(recordResult?.error || 'Media record action failed.');
        }

        const handleSuccess = (newMedia?: Media) => {
          setUploadStatus("success");
          if (newMedia) onUploadSuccess?.(newMedia);
          // Reset form state
          resetFileSelection();
          if (processingStatus !== "processed_error") {
            setProcessingStatus("idle");
          }
          if (!returnJustData) {
            router.refresh();
          }
        };

        if (recordResult?.success && recordResult.data) {
          handleSuccess(recordResult.data);
        } else {
          throw new Error(recordResult?.error || "Media record action failed.");
        }

      } catch (err: unknown) {
        console.error("Upload process error:", err);
        setUploadStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "An unknown error occurred during upload.");
        setUploadProgress(0);
      }
    });
  };

  const handleFolderKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (file) {
      void performUpload();
    }
  };

  return (
    <div className={`border rounded-lg shadow-sm bg-card ${compact ? "p-4" : "p-6 mb-6"}`}>
      <div role="group" aria-label="Upload new media" className={compact ? "space-y-3" : "space-y-4"}>
        <div>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <Label htmlFor="media-file" className="text-base font-medium">Upload New Media</Label>
            <div className="flex items-center gap-2">
              <Label htmlFor="media-folder" className="whitespace-nowrap text-sm text-muted-foreground">Upload Folder:</Label>
              <Input
                id="media-folder"
                placeholder="uploads/"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                onKeyDown={handleFolderKeyDown}
                className="h-9 w-44 sm:w-56"
              />
            </div>
          </div>
          <div className="mt-2 flex items-center justify-center w-full">
            <label
              htmlFor="media-file-input"
              className={`flex flex-col items-center justify-center w-full ${compact ? "h-28" : "h-40"} border-2 border-dashed rounded-lg cursor-pointer bg-muted/30 hover:bg-muted/50 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${
                isDraggingOver ? "border-primary bg-primary-foreground/20" : "border-input"
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
            >
              <div className={`flex flex-col items-center justify-center pointer-events-none ${compact ? "pt-3 pb-4" : "pt-5 pb-6"}`}> {/* pointer-events-none for children */}
                <UploadCloud className={`text-muted-foreground ${compact ? "w-8 h-8 mb-2" : "w-10 h-10 mb-3"}`} />
                <p className="mb-2 text-sm text-muted-foreground">
                  <span className="font-semibold">Click to upload</span> or drag and drop
                </p>
                <p className="text-xs text-muted-foreground">SVG, PNG, JPG, GIF, MP4, PDF (MAX. 10MB)</p>
              </div>
              <Input id="media-file-input" type="file" className="sr-only h-px w-px border-0 p-0" onChange={handleFileChange} ref={fileInputRef} />
            </label>
          </div>
          {previewUrl && file && file.type.startsWith("image/") && (
            <div className="mt-4">
              <Label>Preview:</Label>
              <Image src={previewUrl} alt="Preview" width={300} height={192} className={`mt-2 rounded-md w-auto object-contain border ${compact ? "max-h-32" : "max-h-48"}`} />
            </div>
          )}
          {file && <p className="text-sm mt-2 text-muted-foreground">Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</p>}
        </div>

        {uploadStatus === "uploading" && (
          <Progress value={uploadProgress} className="w-full h-2" />
        )}
        {uploadStatus === "success" && (
         <Alert variant="success" className="mb-4">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>Upload successful!</AlertDescription>
         </Alert>
        )}
        {uploadStatus === "error" && errorMessage && (
          <Alert variant="destructive" className="mb-4">
            <XCircle className="h-4 w-4" />
            <AlertDescription>Error: {errorMessage}</AlertDescription>
          </Alert>
        )}
        {processingStatus === "processing" && (
          <div className="flex items-center text-sm text-blue-600 animate-pulse">
             <Spinner className="mr-2 h-4 w-4" /> Processing image variants...
          </div>
        )}
        {/* Message for when original uploads but variants fail, errorMessage will be set */}


        <Button
          type="button"
          onClick={performUpload}
          disabled={isPending || uploadStatus === "uploading" || processingStatus === "processing" || !file}
          className="w-full sm:w-auto"
        >
          {uploadStatus === "uploading" ? (
             <>
               <Spinner className="mr-2 h-4 w-4" /> Uploading {uploadProgress}%...
             </>
           ) : processingStatus === "processing" ? (
             <>
               <Spinner className="mr-2 h-4 w-4" /> Processing...
             </>
           ) : (
             "Upload File"
           )}
        </Button>
      </div>
    </div>
  );
}
