import { useEffect } from 'react';
import { pathForFile } from '../bridge.js';

/**
 * Window-level file drop.
 *
 * Dropped paths are relativized by the main process and inserted at the
 * composer cursor. Image previews are deliberately absent until common
 * image-prompt RPC support exists (`capabilities.imagePrompt`).
 */
export function useFileDrop(onPaths: (paths: string[]) => void): void {
  useEffect(() => {
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault();
    };
    const onDrop = (event: DragEvent): void => {
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      const paths = [...files].map((file) => pathForFile(file)).filter((path) => path.length > 0);
      if (paths.length > 0) onPaths(paths);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [onPaths]);
}
