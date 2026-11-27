// @ts-check

export function area(shape) {
  if (shape.kind === "circle") return Math.PI * shape.r * shape.r;
  if (shape.kind === "rect") return shape.w * shape.h;
}

export function perimeter(shape) {
  return shape.kind === "circle" ? 2 * Math.PI * shape.r : 2 * (shape.w + shape.h);
}

export function largest(shapes) {
  return shapes.reduce((best, s) => (area(s) > area(best) ? s : best));
}
