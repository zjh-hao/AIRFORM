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
        self.color_rays = np.ascontiguousarray(
            (np.column_stack((xy, np.ones(len(xy)))) @ self.rotation.T).T,
            dtype=np.float32,
        )
        self._tx, self._ty, self._tz = (np.float32(v) for v in self.translation)
        self._fx = np.float32(self.color_k[0, 0])
        self._fy = np.float32(self.color_k[1, 1])
        self._cx = np.float32(self.color_k[0, 2])
        self._cy = np.float32(self.color_k[1, 2])
        self._k1, self._k2, self._p1, self._p2, self._k3 = (np.float32(v) for v in self.color_dist)
        self._has_dist = bool(np.any(self.color_dist != 0))
        self._has_tangential = bool(self._p1 != 0 or self._p2 != 0)
        n_pix = width * height
        self._buf_d = np.empty(n_pix, np.float32)
        self._buf_x = np.empty(n_pix, np.float32)
        self._buf_y = np.empty(n_pix, np.float32)
        self._buf_z = np.empty(n_pix, np.float32)
        self._buf_t1 = np.empty(n_pix, np.float32)
        self._buf_t2 = np.empty(n_pix, np.float32)
        self._buf_r2 = np.empty(n_pix, np.float32)
        self._buf_rad = np.empty(n_pix, np.float32)
        self._buf_xy2 = np.empty(n_pix, np.float32)
        self._aligned = np.empty(n_pix, dtype='<u2')
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
        n = idx.size
        if not n:
            return np.zeros((self.height, self.width), dtype='<u2')
        dv = self._buf_d[:n]
        x = self._buf_x[:n]
        y = self._buf_y[:n]
        cz = self._buf_z[:n]
        dv[:] = z[idx]
        rx, ry, rz = self.color_rays
        np.multiply(rx[idx], dv, out=x); x += self._tx
        np.multiply(ry[idx], dv, out=y); y += self._ty
        np.multiply(rz[idx], dv, out=cz); cz += self._tz
        if cz.min() <= 0:
            front = cz > 0
            n = int(np.count_nonzero(front))
            if not n:
                return np.zeros((self.height, self.width), dtype='<u2')
            x = x[front]; y = y[front]; cz = cz[front]
        np.divide(x, cz, out=x)
        np.divide(y, cz, out=y)
        # OpenCV's five-coefficient lens model using pre-allocated in-place buffers.
        if self._has_dist:
            xx = self._buf_t1[:n]
            yy = self._buf_t2[:n]
            r2 = self._buf_r2[:n]
            rad = self._buf_rad[:n]
            np.multiply(x, x, out=xx)
            np.multiply(y, y, out=yy)
            np.add(xx, yy, out=r2)
            np.multiply(r2, self._k3, out=rad); rad += self._k2; rad *= r2; rad += self._k1; rad *= r2; rad += np.float32(1.0)
            u_f = x * rad
            v_f = y * rad
            if self._has_tangential:
                xy2 = self._buf_xy2[:n]
                np.multiply(x, y, out=xy2); xy2 *= np.float32(2.0)
                if self._p1 != 0:
                    u_f += self._p1 * xy2
                    v_f += self._p1 * (r2 + np.float32(2.0) * yy)
                if self._p2 != 0:
                    u_f += self._p2 * (r2 + np.float32(2.0) * xx)
                    v_f += self._p2 * xy2
            u_f *= self._fx; u_f += self._cx; np.rint(u_f, out=u_f)
            v_f *= self._fy; v_f += self._cy; np.rint(v_f, out=v_f)
            u = u_f.astype(np.int32)
            v = v_f.astype(np.int32)
        else:
            u = np.rint(x * self._fx + self._cx).astype(np.int32)
            v = np.rint(y * self._fy + self._cy).astype(np.int32)
        good = (u >= 0) & (u < self.width) & (v >= 0) & (v < self.height)
        indices = v[good] * self.width + u[good]
        z_mm = np.rint(cz[good]).clip(0, 65534).astype('<u2')
        self._aligned.fill(65535)
        np.minimum.at(self._aligned, indices, z_mm)
        self._aligned[self._aligned == 65535] = 0
        return self._aligned.reshape(self.height, self.width).copy()
