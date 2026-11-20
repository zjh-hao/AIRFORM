"""Factory-calibrated depth-to-color registration; all depths here are mm.

The lab's OBCameraParams are laid out as SW_D2C in its SimpleViewer sample:
l=depth, r=color, r2l_r/t are passed as d2c_r/t despite the legacy names.
We implement projection ourselves; the lab's proprietary D2C DLL is not used.
"""
import cv2
import numpy as np


def intrinsic_matrix(values):
    fx, fy, cx, cy = np.asarray(values, dtype=np.float64)
    if not np.all(np.isfinite([fx, fy, cx, cy])) or min(fx, fy) <= 0:
        raise ValueError('Invalid factory intrinsics')
    return np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1]], dtype=np.float64)


class DepthRegistration:
    """Register native 640x480 depth to an unmirrored 640x480 RGB grid.

    Output is COLOR-camera axial Z (not IR Z or radial distance). Occlusions
    keep the nearest surface. Holes remain zero: never fabricate depth by resize.
    """
    def __init__(self, calibration, width=640, height=480):
        self.width, self.height = width, height
        if (width, height) != (640, 480):
            raise ValueError('Only the factory-calibrated 640x480 profile is supported')
        self.depth_k = intrinsic_matrix(calibration['depth_intrinsics'])
        self.color_k = intrinsic_matrix(calibration['color_intrinsics'])
        self.depth_dist = np.asarray(calibration['depth_distortion'], dtype=np.float64)
        self.color_dist = np.asarray(calibration['color_distortion'], dtype=np.float64)
        self.rotation = np.asarray(calibration['rotation'], dtype=np.float64).reshape(3, 3)
        self.translation = np.asarray(calibration['translation_mm'], dtype=np.float64)
        if (self.depth_dist.shape != (5,) or self.color_dist.shape != (5,)
                or self.translation.shape != (3,)
                or not all(np.all(np.isfinite(v)) for v in (self.depth_dist, self.color_dist, self.rotation, self.translation))
                or not np.allclose(self.rotation @ self.rotation.T, np.eye(3), atol=.01)
                or not np.isclose(np.linalg.det(self.rotation), 1, atol=.01)):
            raise ValueError('Invalid factory extrinsics/distortion')
        y, x = np.mgrid[:height, :width]
        pixels = np.stack((x, y), axis=-1).astype(np.float64).reshape(-1, 1, 2)
        xy = cv2.undistortPoints(pixels, self.depth_k, self.depth_dist).reshape(-1, 2)
        # R is fixed: rotate unit rays once, then scale only valid pixels per frame.
        self.color_rays = (np.column_stack((xy, np.ones(len(xy)))) @ self.rotation.T).T.copy()
        self.metadata = {'width': width, 'height': height,
                         'intrinsics': list(calibration['color_intrinsics']),
                         'distortion': list(calibration['color_distortion']),
                         'depth_unit': 'mm', 'coordinate_system': 'color-camera',
                         'registration': 'factory-calibrated-software', 'mirrored': False}

    def align(self, depth):
        if depth.shape != (self.height, self.width) or depth.dtype != np.uint16:
            raise ValueError('Expected native uint16 depth at calibrated resolution')
        z = depth.ravel()
        idx = np.flatnonzero((z >= 200) & (z <= 4000))
        d = z[idx]
        x, y, cz = (ray[idx] * d + t for ray, t in zip(self.color_rays, self.translation))
        front = cz > 0
        if not front.all():
            x, y, cz = x[front], y[front], cz[front]
        x /= cz
        y /= cz
        # OpenCV's five-coefficient lens model without constructing its unused Jacobian.
        k1, k2, p1, p2, k3 = self.color_dist
        xx, yy, xy2 = x*x, y*y, 2*x*y
        r2 = xx + yy
        radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3))
        u = np.rint(self.color_k[0, 0] * (x*radial + p1*xy2 + p2*(r2 + 2*xx)) + self.color_k[0, 2])
        v = np.rint(self.color_k[1, 1] * (y*radial + p1*(r2 + 2*yy) + p2*xy2) + self.color_k[1, 2])
        good = (u >= 0) & (u < self.width) & (v >= 0) & (v < self.height)
        indices = v[good].astype(np.intp)*self.width + u[good].astype(np.intp)
        aligned = np.full(z.size, np.inf)
        np.minimum.at(aligned, indices, cz[good])
        aligned[~np.isfinite(aligned)] = 0
        return np.rint(aligned).astype('<u2').reshape(self.height, self.width)
