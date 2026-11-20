export function drawHands(context, hands, connections, width, height, color='#63f59b') {
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  for (const points of hands) {
    for (const { start, end } of connections) {
      context.beginPath();
      context.moveTo(points[start].x * width, points[start].y * height);
      context.lineTo(points[end].x * width, points[end].y * height);
      context.stroke();
    }
    for (const point of points) {
      context.beginPath();
      context.arc(point.x * width, point.y * height, 3, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = '#22d3ee';
    context.beginPath();
    context.arc(points[8].x * width, points[8].y * height, 9, 0, Math.PI * 2);
    context.stroke();
    context.strokeStyle = color;
  }
}
