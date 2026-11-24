// Slack rejects the entire block if image_url returns a content-type it can't
// render (e.g. SVG, text/html error pages). Only known-safe raster types pass.
const RENDERABLE_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)(;.*)?$/i

export function isRenderableImageType(contentType: string): boolean {
  return RENDERABLE_IMAGE_TYPES.test(contentType)
}
