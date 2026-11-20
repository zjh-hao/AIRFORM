export function trajectory(stroke, point, count) {
  const u = point / (count - 1), t = u * Math.PI * 4;
  return { x: (stroke % 5 - 2) * 1.7 + .6 * Math.cos(t), y: -1.5 + 3 * u,
    z: Math.floor(stroke / 5) * .25 + .6 * Math.sin(t) };
}

export const strokeStyles = [
  { color: '#35bfff', size: 2 }, { color: '#ff8040', size: 4 }, { color: '#a5e86c', size: 7 },
];
