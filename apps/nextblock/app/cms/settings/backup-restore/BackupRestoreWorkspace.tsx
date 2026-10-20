"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  Progress,
  RadioGroup,
  RadioGroupItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Spinner,
} from "@nextblock-cms/ui";
import { AlertTriangle, CheckCircle2, Download, Upload } from "lucide-react";

import type {
  CmsContentType,
  CmsImportApplyMode,
  CmsImportConflictMode,
  CmsImportSummary,
} from "../../../../lib/cms-transfer/types";
import {
  applyCmsBackupBundleImportAction,
  dryRunCmsBackupBundleImportAction,
  exportCmsBackupBundleAction,
} from "../../import-export/actions";

type BackupMode = "content_json" | "full_zip";
type FullBackupMediaUrlMode = "rewrite_to_destination" | "keep_exact_urls";
type ProgressScope = "export" | "restore";

interface OperationProgress {
  scope: ProgressScope;
  label: string;
  detail: string;
  value: number;
  cap: number;
}

interface FullBackupSummary {
  success: boolean;
  error?: string;
  exportedAt?: string;
  sourceBucket?: string | null;
  sourceBaseUrl?: string | null;
  databaseDumpBytes?: number;
  contentBundleBytes?: number;
  storageObjects?: number;
  missingStorageObjects?: number;
  usersInArchive?: number | null;
  warnings: string[];
  databaseRestored?: boolean;
  storageObjectsUploaded?: number;
  storageObjectsDeleted?: number;
  mediaUrlRewriteMode?: FullBackupMediaUrlMode;
  mediaUrlRowsUpdated?: number;
  usersCreated?: number;
  usersUpdated?: number;
  usersDeleted?: number;
  usersSkipped?: number;
}

const CONTENT_TYPES: Array<{ value: CmsContentType; label: string }> = [
  { value: "pages", label: "Pages" },
  { value: "posts", label: "Posts" },
  { value: "products", label: "Products" },
];

const FULL_RESTORE_CONFIRMATION = "RESTORE FULL BACKUP";

function downloadTextFile(fileName: string, mimeType: string, content: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  downloadBlobFile(fileName, blob);
}

function downloadBlobFile(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsText(file);
  });
}

function getDownloadFileName(response: Response, fallback: string) {
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] || fallback;
}

async function downloadResponseWithProgress(
  response: Response,
  onProgress: (received: number, total: number | null) => void
) {
  const total = Number(response.headers.get("content-length") || 0) || null;
  if (!response.body) {
    const blob = await response.blob();
    onProgress(blob.size, total);
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onProgress(received, total);
  }

  return new Blob(chunks as BlobPart[], {
    type: response.headers.get("content-type") || "application/zip",
  });
}

function postFormDataWithProgress<T>(
  url: string,
  formData: FormData,
  onUploadProgress: (loaded: number, total: number | null) => void,
  onUploadComplete?: () => void
) {
  return new Promise<{ ok: boolean; status: number; body: T }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.upload.onprogress = (event) => {
      onUploadProgress(event.loaded, event.lengthComputable ? event.total : null);
    };
    request.upload.onload = () => onUploadComplete?.();
    request.onerror = () => reject(new Error("Network error while uploading backup."));
    request.onload = () => {
      const body = request.responseText ? JSON.parse(request.responseText) : null;
      resolve({
        ok: request.status >= 200 && request.status < 300,
        status: request.status,
        body: body as T,
      });
    };
    request.send(formData);
  });
}

function formatBytes(value?: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function Summary({ summary }: { summary: CmsImportSummary | null }) {
  if (!summary) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge variant={summary.success ? "default" : "destructive"}>
          {summary.success ? "Ready" : "Needs Fixes"}
        </Badge>
        <Badge variant="outline">{summary.totalRows} rows</Badge>
        <Badge variant="outline">{summary.created} create</Badge>
        <Badge variant="outline">{summary.updated} update</Badge>
        {summary.warnings.length ? (
          <Badge variant="secondary">{summary.warnings.length} warnings</Badge>
        ) : null}
      </div>
      {summary.errors.length ? (
        <Alert variant="destructive">
          <AlertDescription>
            {summary.errors.slice(0, 8).map((error) => (
              <span key={`${error.row}-${error.message}`} className="block">
                Row {error.row}: {error.message}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      {summary.warnings.length ? (
        <Alert>
          <AlertDescription>
            {summary.warnings.slice(0, 6).map((warning) => (
              <span key={`${warning.row}-${warning.message}`} className="block">
                Row {warning.row}: {warning.message}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function FullBackupSummaryPanel({
  summary,
  restored,
}: {
  summary: FullBackupSummary | null;
  restored: boolean;
}) {
  if (!summary) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Badge variant={summary.success ? "default" : "destructive"}>
          {restored ? "Restored" : summary.success ? "Ready" : "Needs Fixes"}
        </Badge>
        <Badge variant="outline">{summary.storageObjects || 0} R2 objects</Badge>
        <Badge variant="outline">{formatBytes(summary.databaseDumpBytes)} DB</Badge>
        <Badge variant="outline">{formatBytes(summary.contentBundleBytes)} content JSON</Badge>
        {typeof summary.usersInArchive === "number" ? (
          <Badge variant="outline">{summary.usersInArchive} accounts</Badge>
        ) : null}
        {summary.missingStorageObjects ? (
          <Badge variant="destructive">{summary.missingStorageObjects} missing files</Badge>
        ) : null}
      </div>

      {summary.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Full Backup Review Failed</AlertTitle>
          <AlertDescription>{summary.error}</AlertDescription>
        </Alert>
      ) : null}

      {restored && summary.success ? (
        <Alert variant="success">
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Restoration Completed Successfully</AlertTitle>
          <AlertDescription>
            Uploaded {summary.storageObjectsUploaded || 0} R2 object(s), restored the database,
            and updated {summary.mediaUrlRowsUpdated || 0} media URL row(s).
            {summary.storageObjectsDeleted ? ` Deleted ${summary.storageObjectsDeleted} extra R2 object(s).` : ""}
            {typeof summary.usersInArchive === "number"
              ? ` Accounts: ${summary.usersCreated || 0} recreated, ${summary.usersUpdated || 0} updated, ${summary.usersDeleted || 0} removed${summary.usersSkipped ? `, ${summary.usersSkipped} skipped` : ""}. Everyone signs in with their original password.`
              : ""}
          </AlertDescription>
        </Alert>
      ) : null}

      {summary.warnings?.length ? (
        <Alert variant="warning">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Warnings</AlertTitle>
          <AlertDescription>
            {summary.warnings.slice(0, 8).map((warning) => (
              <span key={warning} className="block">
                {warning}
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function OperationProgressBar({
  progress,
  scope,
}: {
  progress: OperationProgress | null;
  scope: ProgressScope;
}) {
  if (!progress || progress.scope !== scope) return null;

  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium">{progress.label}</span>
        <span className="tabular-nums text-muted-foreground">{Math.round(progress.value)}%</span>
      </div>
      <Progress value={progress.value} className="h-2" />
      <p className="text-xs text-muted-foreground">{progress.detail}</p>
    </div>
  );
}

export function BackupRestoreWorkspace({
  isEcommerceActive,
}: {
  isEcommerceActive: boolean;
}) {
  const router = useRouter();
  const availableContentTypes = isEcommerceActive
    ? CONTENT_TYPES
    : CONTENT_TYPES.filter((item) => item.value !== "products");
  const contentTypeLabel = isEcommerceActive ? "pages, posts, and products" : "pages and posts";
  const [backupMode, setBackupMode] = useState<BackupMode>("content_json");
  const [bundleJson, setBundleJson] = useState("");
  const [fileName, setFileName] = useState("");
  const [selectedTypes, setSelectedTypes] = useState<CmsContentType[]>(
    isEcommerceActive ? ["pages", "posts", "products"] : ["pages", "posts"]
  );
  const [includeBlocks, setIncludeBlocks] = useState(true);
  const [conflictMode, setConflictMode] =
    useState<CmsImportConflictMode>("overwrite_existing");
  const [applyMode, setApplyMode] = useState<CmsImportApplyMode>("draft");
  const [summary, setSummary] = useState<CmsImportSummary | null>(null);
  const [jsonRestoreComplete, setJsonRestoreComplete] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const clearProgressTimeoutRef = useRef<number | null>(null);

  const [fullZipFile, setFullZipFile] = useState<File | null>(null);
  const [fullSummary, setFullSummary] = useState<FullBackupSummary | null>(null);
  const [fullRestoreComplete, setFullRestoreComplete] = useState(false);
  const [isFullPending, setIsFullPending] = useState(false);
  const [mediaUrlMode, setMediaUrlMode] =
    useState<FullBackupMediaUrlMode>("rewrite_to_destination");
  const [destinationBaseUrl, setDestinationBaseUrl] = useState(
    process.env.NEXT_PUBLIC_R2_BASE_URL || ""
  );
  const [deleteExtraneousR2Objects, setDeleteExtraneousR2Objects] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const clearProgressTimers = () => {
    if (progressTimerRef.current) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (clearProgressTimeoutRef.current) {
      window.clearTimeout(clearProgressTimeoutRef.current);
      clearProgressTimeoutRef.current = null;
    }
  };

  const startProgress = (progress: OperationProgress) => {
    clearProgressTimers();
    setOperationProgress(progress);
    progressTimerRef.current = window.setInterval(() => {
      setOperationProgress((current) => {
        if (!current) return current;
        const remaining = Math.max(0, current.cap - current.value);
        if (remaining <= 0.5) return current;
        return {
          ...current,
          value: Math.min(current.cap, current.value + Math.max(0.7, remaining * 0.07)),
        };
      });
    }, 700) as unknown as number;
  };

  const updateProgress = (patch: Partial<OperationProgress>) => {
    setOperationProgress((current) => (current ? { ...current, ...patch } : current));
  };

  const finishProgress = (label: string, detail: string) => {
    clearProgressTimers();
    setOperationProgress((current) =>
      current
        ? {
            ...current,
            label,
            detail,
            value: 100,
            cap: 100,
          }
        : current
    );
    clearProgressTimeoutRef.current = window.setTimeout(() => {
      setOperationProgress(null);
      clearProgressTimeoutRef.current = null;
    }, 1400) as unknown as number;
  };

  const toggleContentType = (contentType: CmsContentType, checked: boolean) => {
    setSummary(null);
    setJsonRestoreComplete(false);
    setSelectedTypes((current) => {
      if (checked) {
        return Array.from(new Set([...current, contentType]));
      }

      return current.filter((item) => item !== contentType);
    });
  };

  const exportBundle = () => {
    startProgress({
      scope: "export",
      label: "Exporting Content JSON",
      detail: `Collecting ${contentTypeLabel} and blocks.`,
      value: 12,
      cap: 82,
    });
    startTransition(async () => {
      const result = await exportCmsBackupBundleAction();
      if (!result.success || !result.content || !result.fileName || !result.mimeType) {
        clearProgressTimers();
        setOperationProgress(null);
        toast.error(result.error || "Failed to export backup.");
        return;
      }

      updateProgress({
        label: "Downloading Content JSON",
        detail: "Preparing the browser download.",
        value: 92,
        cap: 96,
      });
      downloadTextFile(result.fileName, result.mimeType, result.content);
      finishProgress("Content JSON Exported", "The backup download has started.");
      toast.success("Content JSON backup exported.");
    });
  };

  const exportFullZip = async () => {
    setIsFullPending(true);
    startProgress({
      scope: "export",
      label: "Building Full Site ZIP",
      detail: "Running database backup and collecting R2 media files.",
      value: 5,
      cap: 64,
    });
    try {
      const response = await fetch("/api/cms/full-backup/export", {
        method: "POST",
      });

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(result?.error || "Failed to export full ZIP backup.");
      }

      updateProgress({
        label: "Downloading Full Site ZIP",
        detail: "Receiving the archive from the server.",
        value: 65,
        cap: 96,
      });
      const blob = await downloadResponseWithProgress(response, (received, total) => {
        if (!total) {
          updateProgress({
            value: 84,
            detail: `Downloaded ${formatBytes(received)}.`,
          });
          return;
        }
        updateProgress({
          value: Math.min(98, 65 + (received / total) * 33),
          detail: `Downloaded ${formatBytes(received)} of ${formatBytes(total)}.`,
        });
      });
      downloadBlobFile(
        getDownloadFileName(response, "nextblock-full-site-backup.zip"),
        blob
      );
      finishProgress("Full Site ZIP Exported", "The migration archive download has started.");
      toast.success("Full site ZIP backup exported.");
    } catch (error) {
      clearProgressTimers();
      setOperationProgress(null);
      toast.error(error instanceof Error ? error.message : "Failed to export full ZIP backup.");
    } finally {
      setIsFullPending(false);
    }
  };

  const reviewImport = () => {
    if (!bundleJson.trim()) {
      toast.error("Choose a backup JSON file first.");
      return;
    }
    if (selectedTypes.length === 0 && !includeBlocks) {
      toast.error("Select at least one content type or the Blocks Library.");
      return;
    }

    startProgress({
      scope: "restore",
      label: "Reviewing Content Backup",
      detail: "Validating the JSON file before restore.",
      value: 15,
      cap: 86,
    });
    startTransition(async () => {
      const result = await dryRunCmsBackupBundleImportAction({
        bundleJson,
        contentTypes: selectedTypes,
        conflictMode,
        applyMode,
        includeBlocks,
      });
      setSummary(result);
      setJsonRestoreComplete(false);
      if (result.success) {
        finishProgress("Backup Review Complete", "The content backup is ready to restore.");
        toast.success("Backup review is ready.");
      } else {
        clearProgressTimers();
        setOperationProgress(null);
        toast.error("Backup has errors to fix.");
      }
    });
  };

  const applyImport = () => {
    if (!summary?.success || (selectedTypes.length === 0 && !includeBlocks)) return;

    startProgress({
      scope: "restore",
      label: "Restoring Content Backup",
      detail: "Writing content records and blocks.",
      value: 12,
      cap: 88,
    });
    startTransition(async () => {
      const result = await applyCmsBackupBundleImportAction({
        bundleJson,
        contentTypes: selectedTypes,
        conflictMode,
        applyMode,
        includeBlocks,
      });
      setSummary(result);
      if (!result.success) {
        setJsonRestoreComplete(false);
        clearProgressTimers();
        setOperationProgress(null);
        toast.error("Backup restore failed validation.");
        return;
      }

      setJsonRestoreComplete(true);
      finishProgress("Content Restore Complete", "The content backup was restored successfully.");
      toast.success("Restoration completed successfully.");
      router.refresh();
    });
  };

  const submitFullBackup = async (action: "review" | "restore") => {
    if (!fullZipFile) {
      toast.error("Choose a full backup ZIP file first.");
      return;
    }
    if (action === "restore" && confirmation.trim() !== FULL_RESTORE_CONFIRMATION) {
      toast.error(`Type ${FULL_RESTORE_CONFIRMATION} to confirm full restore.`);
      return;
    }

    const formData = new FormData();
    formData.set("action", action);
    formData.set("file", fullZipFile);
    formData.set("mediaUrlMode", mediaUrlMode);
    formData.set("destinationBaseUrl", destinationBaseUrl);
    formData.set("deleteExtraneousR2Objects", String(deleteExtraneousR2Objects));
    formData.set("confirmation", confirmation);

    setIsFullPending(true);
    startProgress({
      scope: "restore",
      label: action === "restore" ? "Uploading Full Backup" : "Uploading Backup for Review",
      detail: "Sending the ZIP archive to the server.",
      value: 8,
      cap: 46,
    });
    try {
      const response = await postFormDataWithProgress<FullBackupSummary>(
        "/api/cms/full-backup/restore",
        formData,
        (loaded, total) => {
          if (!total) {
            updateProgress({
              value: 34,
              detail: `Uploaded ${formatBytes(loaded)}.`,
            });
            return;
          }
          updateProgress({
            value: Math.min(48, 8 + (loaded / total) * 40),
            detail: `Uploaded ${formatBytes(loaded)} of ${formatBytes(total)}.`,
          });
        },
        () => {
          updateProgress({
            label: action === "restore" ? "Restoring Full Backup" : "Reviewing Full Backup",
            detail:
              action === "restore"
                ? "Re-uploading R2 objects, restoring the database, and rewriting media URLs."
                : "Inspecting the archive manifest and required files.",
            value: 52,
            cap: action === "restore" ? 94 : 86,
          });
        }
      );
      const result = response.body;
      setFullSummary(result);
      setFullRestoreComplete(action === "restore" && result.success);

      if (!response.ok || !result.success) {
        clearProgressTimers();
        setOperationProgress(null);
        toast.error(result.error || "Full backup needs attention.");
        return;
      }

      finishProgress(
        action === "restore" ? "Full Restore Complete" : "Full Backup Review Complete",
        action === "restore"
          ? "The database and R2 media archive were restored."
          : "The ZIP archive is ready to restore."
      );
      toast.success(
        action === "restore"
          ? "Restoration completed successfully."
          : "Full backup review is ready."
      );
      if (action === "restore") router.refresh();
    } catch (error) {
      clearProgressTimers();
      setOperationProgress(null);
      toast.error(error instanceof Error ? error.message : "Failed to process full backup.");
    } finally {
      setIsFullPending(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Backup And Restore</h1>
          <p className="mt-1 text-sm text-muted-foreground">
          Export content-only JSON backups or full migration ZIP archives with database and R2 files.
        </p>
      </div>

      <RadioGroup
        value={backupMode}
        onValueChange={(value) => setBackupMode(value as BackupMode)}
        className="grid gap-3 md:grid-cols-2"
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-4">
          <RadioGroupItem value="content_json" className="mt-1" />
          <span className="space-y-1">
            <span className="block text-sm font-medium">Content JSON</span>
            <span className="block text-sm text-muted-foreground">
              {isEcommerceActive
                ? "Pages, posts, products, metadata, translation groups, blocks, product variants, category slugs, media references, and custom block definitions (Blocks Library). Image binaries are not included."
                : "Pages, posts, metadata, translation groups, blocks, and custom block definitions (Blocks Library). Product content is included only when the ecommerce package is active. Image binaries are not included."}
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-4">
          <RadioGroupItem value="full_zip" className="mt-1" />
          <span className="space-y-1">
            <span className="block text-sm font-medium">Full Site ZIP</span>
            <span className="block text-sm text-muted-foreground">
              Migration archive with a database dump and R2 media files. Restoring this is destructive
              and intended for moving an old server to a new one.
            </span>
          </span>
        </label>
      </RadioGroup>

      <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Export Backup</CardTitle>
            <CardDescription>
              {backupMode === "content_json"
                ? `Download an editable JSON bundle for CMS ${contentTypeLabel}.`
                : "Download a full migration ZIP with database dump and R2 media objects."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {backupMode === "content_json" ? (
              <>
                <Alert>
                  <AlertDescription>
                    The JSON file references existing media by ID and object key, but does not include
                    the image or file binaries from R2.
                  </AlertDescription>
                </Alert>
                <Button onClick={exportBundle} disabled={isPending}>
                  {isPending ? <Spinner className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}
                  Export Content JSON
                </Button>
                <OperationProgressBar progress={operationProgress} scope="export" />
              </>
            ) : (
              <>
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Sensitive Migration Archive</AlertTitle>
                  <AlertDescription>
                    The ZIP can include users, orders, customer data, payment records, settings,
                    database schema, and media files depending on your database permissions.
                  </AlertDescription>
                </Alert>
                <Button onClick={exportFullZip} disabled={isFullPending}>
                  {isFullPending ? <Spinner className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-4" />}
                  Export Full Site ZIP
                </Button>
                <OperationProgressBar progress={operationProgress} scope="export" />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Restore from Backup</CardTitle>
            <CardDescription>
              {backupMode === "content_json"
                ? `Review a content backup before restoring ${contentTypeLabel}.`
                : "Review a full ZIP first, then restore database and R2 media into this environment."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {backupMode === "content_json" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="backup-json-file">Backup JSON file</Label>
                  <Input
                    id="backup-json-file"
                    type="file"
                    accept=".json,application/json"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      setSummary(null);
                      setJsonRestoreComplete(false);
                      if (!file) return;
                      setFileName(file.name);
                      try {
                        setBundleJson(await readFileAsText(file));
                      } catch {
                        toast.error("Failed to read backup file.");
                      }
                    }}
                  />
                  {fileName ? (
                    <p className="text-xs text-muted-foreground">{fileName}</p>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  {availableContentTypes.map((item) => (
                    <label
                      key={item.value}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                    >
                      <Checkbox
                        checked={selectedTypes.includes(item.value)}
                        onCheckedChange={(checked) => toggleContentType(item.value, checked === true)}
                      />
                      {item.label}
                    </label>
                  ))}
                  <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    <Checkbox
                      checked={includeBlocks}
                      onCheckedChange={(checked) => {
                        setIncludeBlocks(checked === true);
                        setSummary(null);
                        setJsonRestoreComplete(false);
                      }}
                    />
                    Blocks Library
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Existing records</Label>
                    <Select
                      value={conflictMode}
                      onValueChange={(value) => {
                        setConflictMode(value as CmsImportConflictMode);
                        setSummary(null);
                        setJsonRestoreComplete(false);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="overwrite_existing">Overwrite matches</SelectItem>
                        <SelectItem value="create_new">Create new copies</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Apply as</Label>
                    <Select
                      value={applyMode}
                      onValueChange={(value) => {
                        setApplyMode(value as CmsImportApplyMode);
                        setSummary(null);
                        setJsonRestoreComplete(false);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft">Drafts</SelectItem>
                        <SelectItem value="live">Live content</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <Summary summary={summary} />
                <OperationProgressBar progress={operationProgress} scope="restore" />

                {jsonRestoreComplete && summary?.success ? (
                  <Alert variant="success">
                    <CheckCircle2 className="h-4 w-4" />
                    <AlertTitle>Restoration Completed Successfully</AlertTitle>
                    <AlertDescription>
                      Restored {summary.totalRows} content row(s): {summary.created} created and{" "}
                      {summary.updated} updated.
                    </AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={reviewImport}
                    disabled={
                      isPending ||
                      !bundleJson.trim() ||
                      (selectedTypes.length === 0 && !includeBlocks)
                    }
                  >
                    {isPending ? <Spinner className="mr-2 h-4 w-4" /> : <Upload className="mr-2 h-4 w-4" />}
                    Review Backup
                  </Button>
                  <Button
                    type="button"
                    onClick={applyImport}
                    disabled={
                      isPending ||
                      !summary?.success ||
                      (selectedTypes.length === 0 && !includeBlocks)
                    }
                  >
                    {isPending ? <Spinner className="mr-2 h-4 w-4" /> : <Upload className="mr-2 h-4 w-4" />}
                    Restore from Backup
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Alert variant="warning">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Full Restore Replaces This Site</AlertTitle>
                  <AlertDescription>
                    This restores R2 files and runs the archived SQL dump against the configured database.
                    Use it for migration from an old server to a new server.
                  </AlertDescription>
                </Alert>

                <div className="space-y-2">
                  <Label htmlFor="backup-zip-file">Full backup ZIP file</Label>
                  <Input
                    id="backup-zip-file"
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(event) => {
                      const file = event.target.files?.[0] || null;
                      setFullZipFile(file);
                      setFullSummary(null);
                      setFullRestoreComplete(false);
                    }}
                  />
                  {fullZipFile ? (
                    <p className="text-xs text-muted-foreground">
                      {fullZipFile.name} ({formatBytes(fullZipFile.size)})
                    </p>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Media URL mode</Label>
                    <Select
                      value={mediaUrlMode}
                      onValueChange={(value) => {
                        setMediaUrlMode(value as FullBackupMediaUrlMode);
                        setFullRestoreComplete(false);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rewrite_to_destination">Use new bucket address</SelectItem>
                        <SelectItem value="keep_exact_urls">Keep exact public URLs</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="destination-base-url">New media base URL</Label>
                    <Input
                      id="destination-base-url"
                      value={destinationBaseUrl}
                      onChange={(event) => {
                        setDestinationBaseUrl(event.target.value);
                        setFullRestoreComplete(false);
                      }}
                      placeholder="https://assets.example.com"
                      disabled={mediaUrlMode === "keep_exact_urls"}
                    />
                  </div>
                </div>

                <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
                  <Checkbox
                    checked={deleteExtraneousR2Objects}
                    onCheckedChange={(checked) => {
                      setDeleteExtraneousR2Objects(checked === true);
                      setFullRestoreComplete(false);
                    }}
                  />
                  <span>
                    <span className="block font-medium">Delete destination R2 files not in the archive</span>
                    <span className="block text-muted-foreground">
                      Advanced cleanup. Leave off unless this new bucket is dedicated to the restored site.
                    </span>
                  </span>
                </label>

                <FullBackupSummaryPanel summary={fullSummary} restored={fullRestoreComplete} />
                <OperationProgressBar progress={operationProgress} scope="restore" />

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="full-restore-confirmation">Destructive restore confirmation</Label>
                  <Input
                    id="full-restore-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder={FULL_RESTORE_CONFIRMATION}
                  />
                  <p className="text-xs text-muted-foreground">
                    Type {FULL_RESTORE_CONFIRMATION} before restoring the full ZIP.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => submitFullBackup("review")}
                    disabled={isFullPending || !fullZipFile}
                  >
                    {isFullPending ? <Spinner className="mr-2 h-4 w-4" /> : <Upload className="mr-2 h-4 w-4" />}
                    Review Full Backup
                  </Button>
                  <Button
                    type="button"
                    onClick={() => submitFullBackup("restore")}
                    disabled={
                      isFullPending ||
                      !fullSummary?.success ||
                      fullRestoreComplete ||
                      confirmation.trim() !== FULL_RESTORE_CONFIRMATION
                    }
                  >
                    {isFullPending ? <Spinner className="mr-2 h-4 w-4" /> : <Upload className="mr-2 h-4 w-4" />}
                    Restore from Backup
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
