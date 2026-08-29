import { useEffect } from 'react';
import { pathForFile } from '../bridge.js';

/**
 * Window-level file drop.
 *
 * Ordinary dropped paths are inserted into the draft. Image-looking files are
 * sent as paths directly to privileged validation; MIME metadata here is only a
 * UX hint and is never trusted by main.
 */
export function useFileDrop(
  onPaths: (paths: string[]) => void,
  onImagePaths?: (paths: string[]) => void,
  imagesEnabled = false,
): void {
  useEffect(() => {
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      const dropped = [...files]
        .map((file) => ({ path: pathForFile(file), imageHint: file.type.startsWith('image/') }))
        .filter((file) => file.path.length > 0);
      const imagePaths = imagesEnabled
        ? dropped.filter((file) => file.imageHint).map((file) => file.path)
        : [];
      const ordinaryPaths = dropped
        .filter((file) => !imagesEnabled || !file.imageHint)
        .map((file) => file.path);
      if (ordinaryPaths.length > 0) onPaths(ordinaryPaths);
      if (imagePaths.length > 0) onImagePaths?.(imagePaths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [imagesEnabled, onImagePaths, onPaths]);
}
