import { useDropzone, type Accept } from "react-dropzone";
import { File as FileIcon, Image as ImageIcon, Paperclip, UploadCloud, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "./button";

interface FileDropzoneProps {
  files: File[];
  onChange: (files: File[]) => void;
  maxFiles?: number;
  maxSizeMb?: number;
  accept?: Accept;
  hint?: string;
  className?: string;
}

const DEFAULT_ACCEPT: Accept = {
  "application/pdf": [".pdf"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "text/csv": [".csv"],
  "text/plain": [".txt", ".md"],
  "image/*": [".png", ".jpg", ".jpeg", ".gif", ".svg"],
  "application/zip": [".zip"]
};

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(file: File) {
  if (file.type.startsWith("image/")) return <ImageIcon className="h-4 w-4 text-info" />;
  return <FileIcon className="h-4 w-4 text-muted-foreground" />;
}

export function FileDropzone({
  files,
  onChange,
  maxFiles = 8,
  maxSizeMb = 25,
  accept = DEFAULT_ACCEPT,
  hint,
  className
}: FileDropzoneProps) {
  const { getRootProps, getInputProps, isDragActive, isDragReject, fileRejections, open } = useDropzone({
    accept,
    maxSize: maxSizeMb * 1024 * 1024,
    maxFiles,
    multiple: true,
    noClick: true,
    onDrop: (accepted) => {
      const merged = [...files, ...accepted].slice(0, maxFiles);
      onChange(merged);
    }
  });

  function remove(index: number) {
    const copy = files.slice();
    copy.splice(index, 1);
    onChange(copy);
  }

  return (
    <div className={cn("grid gap-2", className)}>
      <div
        {...getRootProps()}
        className={cn(
          "group relative grid cursor-pointer place-items-center gap-2 rounded-md border-2 border-dashed border-input bg-muted/30 px-4 py-6 text-center transition hover:border-primary/50 hover:bg-primary/5",
          isDragActive && "border-primary bg-primary/10",
          isDragReject && "border-destructive bg-destructive/10"
        )}
        onClick={open}
      >
        <input {...getInputProps()} />
        <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/10 text-primary">
          <UploadCloud className="h-5 w-5" />
        </div>
        <div className="text-sm">
          <span className="font-semibold text-primary">Click to upload</span>{" "}
          <span className="text-muted-foreground">or drag and drop</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {hint ?? `Up to ${maxFiles} files · ${maxSizeMb} MB max each · PDF, Office, images, code, zip`}
        </p>
      </div>

      {fileRejections.length > 0 && (
        <ul className="grid gap-1 text-xs text-destructive">
          {fileRejections.slice(0, 3).map(({ file, errors }) => (
            <li key={file.name}>
              <span className="font-semibold">{file.name}</span> — {errors.map((e) => e.message).join(", ")}
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="grid gap-1 rounded-md border border-border bg-background p-2">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted/50">
              {iconFor(file)}
              <span className="flex-1 truncate font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(index);
                }}
                aria-label={`Remove ${file.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
          <li className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
            <Paperclip className="h-3 w-3" />
            {files.length} of {maxFiles} attached
          </li>
        </ul>
      )}
    </div>
  );
}
