/**
 * Uploading media from the studio (docs/api/openapi.yaml, Studio media).
 *
 * 1. Ask the API for an upload slot; the URL is presigned for this exact type and size.
 * 2. PUT the file straight to storage (the API never streams it), reporting progress.
 * 3. Tell the API it arrived; it checks the file and queues videos for transcoding.
 * 4. For a video, poll until the worker has made it ready (or refused it).
 */
import { api } from '@mathpath/client';

export type MediaKind = 'video' | 'image' | 'subtitle';
export type MediaStatus = 'awaiting_upload' | 'uploaded' | 'processing' | 'ready' | 'failed';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  contentType: string;
  sizeBytes: number;
  locale: string | null;
  videoId: string | null;
  durationS: number | null;
  renditions: { name: string; height: number | null; bandwidth: number }[];
  error: string | null;
  previewUrl: string | null;
}

export interface UploadRequest {
  kind: MediaKind;
  file: Blob | { type: string; size: number };
  locale?: string;
  videoId?: string;
}

/** Sends the bytes; the browser version is {@link xhrPut}. */
export type PutFile = (
  url: string,
  file: Blob | { type: string; size: number },
  onProgress: (fraction: number) => void,
) => Promise<void>;

export interface UploadDeps {
  call: typeof api;
  put: PutFile;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): UploadDeps => ({
  call: api,
  put: xhrPut,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Steps 1–3. @returns The asset after "complete" (a video is `uploaded`, others `ready`). */
export async function uploadMedia(
  request: UploadRequest,
  onProgress: (fraction: number) => void,
  deps: UploadDeps = defaultDeps(),
): Promise<MediaAsset> {
  const slot = await deps.call<{ mediaId: string; uploadUrl: string }>('/studio/media/uploads', {
    method: 'POST',
    body: {
      kind: request.kind,
      contentType: request.file.type,
      sizeBytes: request.file.size,
      ...(request.locale ? { locale: request.locale } : {}),
      ...(request.videoId ? { videoId: request.videoId } : {}),
    },
  });
  await deps.put(slot.uploadUrl, request.file, onProgress);
  return deps.call<MediaAsset>(`/studio/media/${slot.mediaId}/complete`, { method: 'POST' });
}

/**
 * Step 4: polls a video until it is ready or failed, backing off from 2 s to 15 s.
 * @param onUpdate - Called with each status, so the screen can say "processing".
 */
export async function waitUntilReady(
  mediaId: string,
  onUpdate: (asset: MediaAsset) => void,
  deps: UploadDeps = defaultDeps(),
  timeoutMs = 30 * 60_000,
): Promise<MediaAsset> {
  let delay = 2000;
  let waited = 0;
  for (;;) {
    const asset = await deps.call<MediaAsset>(`/studio/media/${mediaId}`);
    onUpdate(asset);
    if (asset.status === 'ready' || asset.status === 'failed') return asset;
    if (waited >= timeoutMs) return asset;
    await deps.sleep(delay);
    waited += delay;
    delay = Math.min(delay * 1.5, 15_000);
  }
}

/** PUT with upload progress; fetch() cannot report upload progress yet. */
export const xhrPut: PutFile = (url, file, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`upload failed with ${xhr.status}`));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file as Blob);
  });
