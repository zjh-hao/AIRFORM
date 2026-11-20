import { OrthographicCamera } from 'three';

// A fixed world-space brush should keep its visible width as its Z changes.
// Orthographic projection preserves real XYZ and depth testing without scaling
// nearer strokes. Fit the same reference plane at every viewport aspect ratio.
export function fitDrawingCamera(camera, width, height, plane) {
  if (!(width > 0 && height > 0)) return;
  const aspect = width / height;
  const halfHeight = 1.1 * Math.max(plane.height / 2, plane.width / 2 / aspect);
  camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
  camera.top = halfHeight; camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

export function createDrawingCamera(width, height, plane) {
  const camera = new OrthographicCamera(-1, 1, 1, -1, .1, 100);
  camera.position.set(0, 0, 8);
  fitDrawingCamera(camera, width, height, plane);
  return camera;
}
